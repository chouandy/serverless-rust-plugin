'use strict';

const path = require('path');
const fs = require('fs');
const Cargo = require('./lib/cargo');
const CargoLambda = require('./lib/cargolambda');

const DEFAULT_DOCKER_TAG = 'latest';
const DEFAULT_DOCKER_IMAGE = 'calavera/cargo-lambda';
const NO_OUTPUT_CAPTURE = { stdio: ['ignore', process.stdout, process.stderr] };

// https://serverless.com/blog/writing-serverless-plugins/
// https://serverless.com/framework/docs/providers/aws/guide/plugins/

function mkdirSyncIfNotExist(dirname) {
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

class ServerlessRustPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.servicePath = this.serverless.config.servicePath || '';
    this.hooks = {
      'before:package:createDeploymentArtifacts': this.buildZip.bind(this),
      'before:deploy:function:packageFunction': this.buildZip.bind(this),
    };

    this.srcPath = path.resolve(this.servicePath);

    // MEMO: Customization for docker is disabled in 0.1.0 release.
    this.custom = {
      // dockerTag: DEFAULT_DOCKER_TAG,
      // dockerImage: DEFAULT_DOCKER_IMAGE,
      cargoPath: path.join(this.srcPath, 'Cargo.toml'),
      useDocker: true,
      ...((this.serverless.service.custom && this.serverless.service.custom.rust) || {}),
    };

    this.cargo = new Cargo(this.custom.cargoPath);
  }

  log(message) {
    this.serverless.cli.log(`[ServerlessRustPlugin]: ${message}`);
  }

  deployArtifactDir(profile) {
    return path.join(this.srcPath, 'target/lambda', profile);
  }

  functions() {
    return this.serverless.service.getAllFunctions();
  }

  providerIsAws() {
    return this.serverless.service.provider.name === 'aws';
  }

  buildOptions(options = {}) {
    return {
      useDocker: this.custom.useDocker,
      srcPath: this.srcPath,
      dockerImage: `${DEFAULT_DOCKER_IMAGE}:${DEFAULT_DOCKER_TAG}`,
      profile: this.custom.cargoProfile || CargoLambda.profile.release,
      arch: this.serverless.service.provider.architecture || CargoLambda.architecture.x86_64,
      format: CargoLambda.format.zip,
      ...options,
    };
  }

  getRustFunctions() {
    const { service } = this.serverless;
    const binaryNames = this.cargo.binaries();

    return this.functions().flatMap((funcName) => {
      const func = service.getFunction(funcName);
      return binaryNames.some((bin) => bin === func.handler) ? funcName : [];
    });
  }

  // MEMO:
  // If multiple artifacts have same file name like bootstrap.zip,
  // the serverless framework fails to deploy each artifacts correctly.
  // But cargo lambda builds all artifacts into same name bootstrap(.zip),
  // so this plugin copies artifacts using each function name and deploys them.
  // See: https://github.com/serverless/serverless/issues/3696
  resetEachPackage({ rustFunctions, builder, targetDir }) {
    const { service } = this.serverless;

    rustFunctions.forEach((funcName) => {
      const func = service.getFunction(funcName);
      const binaryName = func.handler;

      const buildArtifactPath = builder.artifactPath(binaryName);
      const deployArtifactPath = path.join(targetDir, `${funcName}${builder.artifactExt()}`);

      fs.createReadStream(buildArtifactPath)
        .pipe(fs.createWriteStream(deployArtifactPath));

      func.handler = builder.useZip() ? 'bootstrap' : path.basename(deployArtifactPath);
      func.package = {
        ...(func.package || {}),
        artifact: deployArtifactPath,
        individually: true,
      };
    });
  }

  build(builder) {
    const rustFunctions = this.getRustFunctions();

    if (rustFunctions.length === 0) {
      throw new Error(
        'Error: no Rust functions found. '
        + 'Use "handler: {cargo-package-name}.{bin-name}" or "handler: {cargo-package-name}" '
        + 'in function configuration to use this plugin.',
      );
    }

    this.log(builder.howToBuild());
    this.log(`Running "${builder.buildCommand()}"`);

    const result = builder.build(NO_OUTPUT_CAPTURE);

    if (result.error || result.status > 0) {
      this.log(`Rust build encountered an error: ${result.error} ${result.status}.`);
      throw new Error(result.error);
    }

    const targetDir = this.deployArtifactDir(builder.profile);
    mkdirSyncIfNotExist(targetDir);

    this.resetEachPackage({
      rustFunctions,
      targetDir,
      builder,
    });
  }

  buildZip() {
    if (this.providerIsAws()) {
      const options = this.buildOptions({ format: CargoLambda.format.zip });
      const builder = new CargoLambda(options);
      this.build(builder);
    }
  }

  buildBinary() {
    if (this.providerIsAws()) {
      const options = this.buildOptions({ format: CargoLambda.format.binary });
      const builder = new CargoLambda(options);
      this.build(builder);
    }
  }
}

module.exports = ServerlessRustPlugin;
