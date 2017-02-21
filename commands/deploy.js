'use strict';

// TODO: rewrite to use got instead of request

// Native
const fs = require('fs');

// Packages
const bitbucketjs = require('bitbucketjs');
const chalk = require('chalk');
const clone = require('clone');
const DigitalOcean = require('digitalocean-v2');
const escapeStringRegexp = require('escape-string-regexp');
const fingerprint = require('ssh-fingerprint');
const GitHubApi = require('github');
const hostedGitInfo = require('hosted-git-info');
const NodeSSH = require('node-ssh');
const request = require('request-promise');
const semver = require('semver');

// Ours
const cfg = require('../lib/cfg');
const CloudConfig = require('../lib/cloud-config');
const error = require('../lib/utils/output/error');
const genreateKeypair = require('../lib/generateKeypair');
const getBitBucketCredentials = require('../lib/get-bitbucket-credentials');
const getDigitalOceanCredentials = require('../lib/get-digitalocean-credentials');
const getGitHubCredentials = require('../lib/get-github-credentials');
const getNodecgTarballUrl = require('../lib/get-nodecg-tarball-url');
const getPublicKey = require('../lib/get-public-key');
const success = require('../lib/utils/output/success');
const wait = require('../lib/utils/output/wait');

const ssh = new NodeSSH();
const config = cfg.read();
const github = new GitHubApi();
const unauthenticatedBitbucket = bitbucketjs();
const DROPLET_USERNAME = 'nodecg';
const NODECG_DIR = `/home/${DROPLET_USERNAME}/nodecg`;
const BUNDLES_DIR = `${NODECG_DIR}/bundles`;

module.exports = function (program) {
	program
		.command('deploy <filePath>')
		.description('Deploys the given NodeCG instance to DigitalOcean')
		.action(action);
};

async function action(filePath) {
	// TODO: json schema with defaults
	const file = fs.readFileSync(filePath);
	let deploymentDefinition = JSON.parse(file);
	deploymentDefinition.bundles = parseBundles(deploymentDefinition);

	/*
	 1. Make the Block Storage volume if it doesn't yet exist.
	 2. Make the droplet with name "${name}-staging", but don't attach the volume yet. It will mostly auto-provision thanks to the cloud-init script.
	 3. Wait for the droplet to finish being provisioned. (Don't yet have a good way of signaling when this has happened)
	 4. Assign the Floating IP to the new droplet, and attach the Block Storage volume to it.
	 5. Run a small script that makes a new LE cert *only if* there isn't one already on the volume.
	 6.
	 */

	try {
		const credentials = await gatherNeededCredentials(deploymentDefinition);

		const stopGatherDownloadUrlsSpinner = wait('Gather download URLs for NodeCG and bundles');
		deploymentDefinition = await gatherDownloadUrls(deploymentDefinition, credentials);
		stopGatherDownloadUrlsSpinner();
		process.stdout.write(`${chalk.cyan('✓')} Gather download URLs for NodeCG and bundles\n`);

		const stopGenerateKeypairSpinner = wait('Generate keypair (will be discarded after initial setup)');
		credentials.keypair = genreateKeypair();
		stopGenerateKeypairSpinner();
		process.stdout.write(`${chalk.cyan('✓')} Generate keypair (will be discarded after initial setup)\n`);

		const stopGenerateCloudConfigSpinner = wait('Generate cloud-init script');
		const cloudConfig = await generateCloudConfig(deploymentDefinition, credentials);
		stopGenerateCloudConfigSpinner();
		process.stdout.write(`${chalk.cyan('✓')} Generate cloud-init script\n`);

		const stopCreateDropletSpinner = wait('Create droplet');
		const digitalOceanApi = new DigitalOcean(credentials.digitalocean);
		const dropletConfig = Object.assign({}, deploymentDefinition.droplet);
		dropletConfig.ssh_keys = [fingerprint(credentials.publickey)]; // eslint-disable-line camelcase
		dropletConfig.user_data = cloudConfig.dump(); // eslint-disable-line camelcase
		fs.writeFileSync('cloud-config.yml', dropletConfig.user_data, 'utf-8'); // TODO: remove this
		const dropletCreationResult = await digitalOceanApi.createDroplet(dropletConfig);
		stopCreateDropletSpinner();
		process.stdout.write(`${chalk.cyan('✓')} Create droplet\n`);

		// Keep getting droplet info until it tells us what its IPv4 address is
		const stopWaitForBootSpinner = wait('Wait for droplet to finish booting');
		const droplet = await new Promise(resolve => {
			const interval = setInterval(() => {
				digitalOceanApi.getDroplet(dropletCreationResult.id).then(dropletStatus => {
					if (dropletStatus.status === 'active') {
						clearInterval(interval);
						resolve(dropletStatus);
					}
				});
			}, 2500);
		});
		stopWaitForBootSpinner();
		process.stdout.write(`${chalk.cyan('✓')} Wait for droplet to finish booting\n`);

		const dropletIp = droplet.networks.v4[0].ip_address;
		const stopSshToDropletSpinner = wait(`ssh to droplet (${dropletIp})`);
		await new Promise((resolve, reject) => {
			// Try to connect every 2.5s
			const interval = setInterval(() => {
				ssh.connect({
					host: dropletIp,
					username: 'nodecg',
					privateKey: credentials.keypair.private
				}).then(() => {
					clearInterval(interval);
					resolve();
				}).catch(err => {
					if (err.code === 'ECONNREFUSED') {
						// retry
					} else {
						stopSshToDropletSpinner();
						clearInterval(interval);
						process.stdout.write(`${chalk.red('✗')} ssh to droplet\n`);

						if (err.code) {
							error(`Failed to ssh to droplet: ${err.code}`);
						} else {
							error(`Failed to ssh to droplet: ${err}`);
						}

						reject(err);
					}
				});
			}, 2500);
		});
		stopSshToDropletSpinner();
		process.stdout.write(`${chalk.cyan('✓')} ssh to droplet\n`);

		// TODO: Have a timeout for this
		// TODO: handle errors here
		const stopWaitForCloudInitSpinner = wait('Wait for cloud-init to complete on droplet');
		await new Promise((resolve, reject) => {
			// Check every 2.5s
			const interval = setInterval(() => {
				isBootFinished(ssh).then(isFinished => {
					if (isFinished) {
						clearInterval(interval);
						resolve();
					}
				}).catch(errors => {
					stopWaitForCloudInitSpinner();
					clearInterval(interval);

					if (Array.isArray(errors)) {
						error(`cloud-init failed:\n\t${errors.join('\n\t')}`);
					} else {
						error(`cloud-init failed:\n\t${errors}`);
					}

					reject(errors);
				});
			}, 2500);
		});
		stopWaitForCloudInitSpinner();
		process.stdout.write(`${chalk.cyan('✓')} Wait for cloud-init to complete on droplet\n`);

		// Remove our setup key from authorized_keys
		const stopRemoveSetupKeySpinner = wait('Remove setup key from authorized_keys');
		const removeSetupKeyResult = await ssh.execCommand(
			`sed -i -e '/${escapeStringRegexp(credentials.keypair.ssh.slice(-18).slice(2, 16))}/d' /home/nodecg/.ssh/authorized_keys`
		);
		stopRemoveSetupKeySpinner();

		if (removeSetupKeyResult.stderr) {
			process.stdout.write(`${chalk.red('✗')} Remove setup key from authorized_keys\n`);
			error(removeSetupKeyResult.stderr);
		} else {
			process.stdout.write(`${chalk.cyan('✓')} Remove setup key from authorized_keys\n`);
			success('NodeCG deployed!');
		}

		// TODO: there has to be a better way to end this process than this lol.
		return new Promise(resolve => resolve());
	} catch (e) {
		console.error(e);
		return new Promise((resolve, reject) => reject());
	}
}

/**
 * When cloud-init is done, it writes a result.json file.
 * By checking for the existence of this file, we can know if cloud-init has completed.
 * This file will also contain an array of errors, if cloud-init encountered any.
 * @param {NodeSSH} ssh - A connected SSH tunnel.
 * @returns {Promise} - A promise that will resolve with a Boolean, or reject with an array of error strings.
 */
function isBootFinished(ssh) {
	return new Promise((resolve, reject) => {
		ssh.execCommand(
			'[ -f /var/lib/cloud/data/result.json ] && cat /var/lib/cloud/data/result.json || echo "Not found"'
		).then(result => {
			if (result.stdout === 'Not found') {
				return resolve(false);
			} else if (result.stdout) {
				const resultJson = JSON.parse(result.stdout).v1;
				if (resultJson.errors && resultJson.errors.length > 0) {
					return reject(resultJson.errors);
				}

				return resolve(true);
			}

			reject(result.stderr);
		}).catch(error => {
			reject(error);
		});
	});
}

function parseBundles(deploymentDefinition) {
	const bundles = [];
	for (const bundleName in deploymentDefinition.bundles) {
		if (!{}.hasOwnProperty.call(deploymentDefinition.bundles, bundleName)) {
			continue;
		}

		const bundle = deploymentDefinition.bundles[bundleName];
		bundle.name = bundleName;
		bundle.hostedGitInfo = hostedGitInfo.fromUrl(bundle.url);
		bundles.push(bundle);
	}
	return bundles;
}

function gatherNeededCredentials(deploymentDefinition) {
	// TODO: ask for multiple public keys
	return new Promise(resolve => {
		const credentials = {
			bitbucket: {
				username: config.bitBucketUsername,
				password: config.bitBucketPassword
			},
			github: {
				token: config.gitHubToken
			},
			publickey: config.publicKey,
			digitalocean: {
				token: config.digitalOceanToken
			}
		};

		// If we already have credentials for every service that we support (currently just BitBucket
		// and GitHub), then we can bail out early and return those credentials.
		if (config.bitBucketUsername && config.bitBucketPassword && config.gitHubToken && config.publicKey &&
			config.digitalOceanToken) {
			return resolve({
				bitbucket: {
					username: config.bitBucketUsername,
					password: config.bitBucketPassword
				},
				github: {
					token: config.gitHubToken
				},
				publickey: config.publicKey,
				digitalocean: {
					token: config.digitalOceanToken
				}
			});
		}

		// Else, we need to determine what credentials we need before continuing.
		let bitbucketCredentialsNeeded = false;
		let githubCredentialsNeeded = false;
		const permissionCheckPromises = [];
		deploymentDefinition.bundles.forEach(bundle => {
			let promise;
			if (bundle.hostedGitInfo.type === 'bitbucket') {
				// Do nothing if we already have credentials for BitBucket.
				if (config.bitBucketUsername && config.bitBucketPassword) {
					return;
				}

				// Check if the BitBucket repo needs authentication. If it does, note that for later.
				promise = unauthenticatedBitbucket.repo.fetch('endofline/ubi-division').then().catch(error => {
					if (error.status === 403) {
						bitbucketCredentialsNeeded = true;
					}
				});
			} else if (bundle.hostedGitInfo.type === 'github') {
				// Do nothing if we already have credentials for GitHub.
				if (config.bitBucketUsername && config.bitBucketPassword) {
					return;
				}

				// Check if the GitHub repo needs authentication. If it does, note that for later.
				promise = github.repos.getDownloads({
					owner: 'owner',
					repo: 'repo'
				}).then().catch(error => {
					// GitHub will return a 404 if trying to access a repo that you don't have permissions for,
					// rather than explicitly saying that you don't have access. So, it's possible that
					// at this point the user entered a non-existent repo, but we must assume that they didn't
					// and that we just need to authenticate before we can see it.
					if (error.code === 404) {
						githubCredentialsNeeded = true;
					}
				});
			} else {
				// TODO: handle unknown or other hostingProviders
			}

			permissionCheckPromises.push(promise);
		});

		Promise.all(permissionCheckPromises).then(() => {
			return getPublicKey().then(publicKey => {
				credentials.publickey = publicKey;
			});
		}).then(() => {
			return getDigitalOceanCredentials().then(token => {
				credentials.digitalocean = {token};
			});
		}).then(() => {
			if (githubCredentialsNeeded) {
				return getGitHubCredentials().then(token => {
					credentials.github = {token};
				});
			}
		}).then(() => {
			if (bitbucketCredentialsNeeded) {
				return getBitBucketCredentials().then(bbCreds => {
					credentials.bitbucket = bbCreds;
				});
			}
		}).then(() => {
			resolve(credentials);
		});
	});
}

function gatherDownloadUrls(deploymentDefinition, credentials) {
	const authenticatedBitbucket = bitbucketjs(credentials.bitbucket);

	if (credentials.github && credentials.github.token) {
		github.authenticate({
			type: 'token',
			token: credentials.github.token
		});
	}

	const newDeploymentDefinition = clone(deploymentDefinition);

	const promises = [];
	newDeploymentDefinition.bundles.forEach(bundle => {
		let promise;
		if (bundle.hostedGitInfo.type === 'bitbucket') {
			promise = authenticatedBitbucket.repo.fetch(
				`${bundle.hostedGitInfo.user}/${bundle.hostedGitInfo.project}`
			).then(result => {
				return request({
					uri: result.links.tags.href,
					auth: {
						username: credentials.bitbucket.username,
						password: credentials.bitbucket.password
					},
					json: true
				});
			}).then(json => {
				const tagNames = json.values.map(tag => tag.name);
				const target = semver.maxSatisfying(tagNames, bundle.version);
				bundle.downloadUrl = `https://bitbucket.org/${bundle.hostedGitInfo.user}/${bundle.hostedGitInfo.project}/get/${target}.zip`;
			});
		} else if (bundle.hostedGitInfo.type === 'github') {
			// TODO: actually handle github downloads instead of just having this stub
			promise = github.repos.getDownloads({
				owner: 'owner',
				repo: 'repo'
			}).then();
		} else {
			// TODO: handle unknown or other hosting providers
		}

		promises.push(promise);
	});

	return Promise.all(promises).then(() => {
		return newDeploymentDefinition;
	});
}

// TODO: Files should be owned by DROPLET_USERNAME
function generateCloudConfig(deploymentDefinitionWithDownloadUrls, credentials) {
	const cloudConfig = new CloudConfig('templates/cloud-config.yml');

	cloudConfig.addSshKey(DROPLET_USERNAME, credentials.publickey);
	cloudConfig.addSshKey(DROPLET_USERNAME, credentials.keypair.ssh); // Only used during setup, then deleted from authorized_keys.

	if (deploymentDefinitionWithDownloadUrls.nodecg.config) {
		cloudConfig.addWriteFile(`${NODECG_DIR}/cfg/nodecg.json`, deploymentDefinitionWithDownloadUrls.nodecg.config);
	}

	cloudConfig.replace('{{nodejs_version}}', deploymentDefinitionWithDownloadUrls.nodejs_version);
	cloudConfig.replace('{{domain}}', deploymentDefinitionWithDownloadUrls.domain);
	cloudConfig.replace('{{port}}', deploymentDefinitionWithDownloadUrls.nodecg.port);
	cloudConfig.replace('{{email}}', deploymentDefinitionWithDownloadUrls.email);

	// Download NodeCG
	return getNodecgTarballUrl(deploymentDefinitionWithDownloadUrls.nodecg.version).then(nodecgTarballUrl => {
		cloudConfig.addDownload(nodecgTarballUrl, {
			dest: `/home/${DROPLET_USERNAME}/nodecg.tar.gz`,
			unpack: true
		});

		deploymentDefinitionWithDownloadUrls.bundles.forEach(bundle => {
			cloudConfig.addDownload(bundle.downloadUrl, {
				dest: `${BUNDLES_DIR}/${bundle.name}.zip`,
				unpack: true,
				auth: {
					username: credentials.bitbucket.username,
					password: credentials.bitbucket.password
				}
			});

			// BitBucket's zips have a folder within them with the name ${user}-${repo}-${hash},
			// so we need to rename this folder to just be ${repo}.
			if (bundle.hostedGitInfo.type === 'bitbucket') {
				cloudConfig.addCommand(`find ${BUNDLES_DIR}/* -maxdepth 0 -type d -name "*${bundle.name}*" -execdir mv {} ${bundle.name} \\;`);
			}

			if (bundle.config) {
				cloudConfig.addWriteFile(`${NODECG_DIR}/cfg/${bundle.name}.json`, bundle.config);
			}
		});

		// Transfer ownership of these newly-downloaded files to the nodecg user
		cloudConfig.addCommand('chown -R nodecg:nodecg /home/nodecg/');

		return cloudConfig;
	});
}
