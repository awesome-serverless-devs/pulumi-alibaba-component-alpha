import * as pulumiAuto from '@pulumi/pulumi/x/automation';
import * as path from 'path';
// import * as uuid from 'uuid';
import * as os from 'os';
import * as fse from 'fs-extra';
import commandExists from 'command-exists';
import * as shell from 'shelljs';
import * as core from '@serverless-devs/core';
import * as util from 'util';
import { getLatestVersionOfPackage } from './utils/npm-pkg';
import * as _ from 'lodash';

const { runPulumiCmd } = require('@pulumi/pulumi/x/automation/cmd');

const DEFAULT = {
  region: 'cn-hangzhou',
  workDir: '.',
  runtime: 'nodejs',
  pulumiHome: path.join(os.homedir(), '.pulumi'),
};

const SUPPORTED_CLOUD_PLATFORMS = ['alicloud'];
const PULUMI_INSTALL_FILE_PATH = path.join(__dirname, 'utils/pulumi/install.js');

export default class PulumiComponent {
  @core.HLogger('PULUMI-ALIBABA') logger: core.ILogger;
  constructor() {
    if (fse.pathExistsSync(DEFAULT.pulumiHome) && commandExists.sync('pulumi')) {
      // pulumi cli exists
      this.pulumiDir = path.dirname(DEFAULT.pulumiHome);
      this.pulumiHome = DEFAULT.pulumiHome;
      this.pulumiAlreadyExists = true;
    } else {
      this.pulumiDir = os.homedir();
      this.pulumiHome = path.join(this.pulumiDir, '.pulumi');
      this.pulumiBin = path.join(this.pulumiHome, 'bin');
      this.pulumiPath = path.join(this.pulumiBin, 'pulumi');

      if (!fse.pathExistsSync(this.pulumiPath)) {
        shell.exec(`node ${PULUMI_INSTALL_FILE_PATH}`);
      }
      this.pulumiAlreadyExists = false;
    }

    this.pulumiConfigPassphrase = 'password';
    this.logger.info(`PULUMI_CONFIG_PASSPHRASE is ${this.pulumiConfigPassphrase}`);

    if (!this.pulumiAlreadyExists) {
      process.env.PATH = `${process.env.PATH }:${this.pulumiBin}`;
    }
    this.pulumiEnvs = {
      PULUMI_CONFIG_PASSPHRASE: this.pulumiConfigPassphrase,
      PULUMI_SKIP_UPDATE_CHECK: 'true',
      PULUMI_ENABLE_LEGACY_PLUGIN_SEARCH: 'false',
      PULUMI_SKIP_CONFIRMATIONS: 'true',
      PULUMI_HOME: this.pulumiHome,
      ...process.env,
    };
  }

  // 解析入参
  async handlerInputs(inputs) {
    const prop = inputs?.Properties || inputs?.properties;
    const project = inputs?.project || inputs?.Project;
    const provider = project?.Provider || project?.provider;
    const accessAlias = project?.AccessAlias || project?.accessAlias;
    const args = inputs?.Args || inputs?.args;
    const credentials = await core.getCredential(provider, accessAlias || '');

    const workDir = prop?.workDir || DEFAULT.workDir;
    const runtime: pulumiAuto.ProjectRuntime = prop?.runtime || DEFAULT.runtime;
    const region = prop?.region || DEFAULT.region;
    const cloudPlatform = prop?.cloudPlatform;
    const stackName = prop?.stackName;
    const projectName = prop?.projectName;

    if (!cloudPlatform || (SUPPORTED_CLOUD_PLATFORMS.indexOf(cloudPlatform) < 0)) {
      this.logger.error(`\n${cloudPlatform} not supported now, supported cloud platform includes [${SUPPORTED_CLOUD_PLATFORMS}]`);
      throw new Error(`${cloudPlatform} not supported now, supported cloud platform includes ${SUPPORTED_CLOUD_PLATFORMS}`);
    }

    return {
      credentials,
      workDir,
      runtime,
      region,
      args,
      cloudPlatform,
      stackName,
      projectName,
    };
  }

  async loginPulumi(url?: string, isLocal?: boolean, isSilent?: boolean): Promise<void> {
    if (isLocal) {
      await runPulumiCmd(['login', `file://${this.pulumiDir}`], process.cwd(), this.pulumiEnvs, isSilent ? undefined : console.log);
    } else {
      await runPulumiCmd(['login', url], process.cwd(), this.pulumiEnvs, isSilent ? undefined : console.log);
    }
  }


  async login(inputs): Promise<void> {
    const { args, credentials } = await this.handlerInputs(inputs);
    this.logger.debug(`args: ${JSON.stringify(args)}`);
    const parsedArgs: {[key: string]: any} = core.commandParse({ args }, { boolean: ['s', 'silent', 'local'] });
    this.logger.debug(`parsedArgs: ${JSON.stringify(parsedArgs)}`);
    const nonOptionsArgs = parsedArgs.data?._;

    const isSilent = parsedArgs.data?.s || parsedArgs.data?.silent;
    const isLocal = parsedArgs.data?.local;
    if (_.isEmpty(nonOptionsArgs) && !isLocal) {
      this.logger.error('error: expects argument.');
      // help info
      return;
    }
    if (nonOptionsArgs.length > 1) {
      this.logger.error(`error: unexpected argument: ${nonOptionsArgs[1]}`);
      // help info
      return;
    }
    const loginUrl = nonOptionsArgs[0];
    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'login',
        account: credentials.AccountID,
      },
    });
    await this.loginPulumi(loginUrl, isLocal, isSilent);
  }

  async getStack(stackName: string, workDir: string, projectName?: string, runtime?: pulumiAuto.ProjectRuntime): Promise<pulumiAuto.Stack> {
    const LocalProgramArgs: pulumiAuto.LocalProgramArgs = {
      stackName,
      workDir,
    };
    const wsOpts: pulumiAuto.LocalWorkspaceOptions = {
      workDir,
      pulumiHome: this.pulumiHome,
      envVars: this.pulumiEnvs,
    };

    if (projectName && runtime) {
      wsOpts.projectSettings = {
        name: projectName,
        runtime,
      };
    }
    const stack = await pulumiAuto.LocalWorkspace.selectStack(LocalProgramArgs, wsOpts);
    return stack;
  }

  async createStack(workDir: string, projectName: string, runtime: pulumiAuto.ProjectRuntime, stackName: string): Promise<pulumiAuto.Stack> {
    const wsOpts: pulumiAuto.LocalWorkspaceOptions = {
      workDir,
      pulumiHome: this.pulumiHome,
      envVars: this.pulumiEnvs,
      projectSettings: {
        name: projectName,
        runtime,
      },
    };

    // const inlineProgramArgs: pulumiAuto.InlineProgramArgs = {
    //   stackName,
    //   projectName,
    //   program: p()
    // };

    const localProgramArgs: pulumiAuto.LocalProgramArgs = {
      stackName,
      workDir,
    };
    const stack = await pulumiAuto.LocalWorkspace.createOrSelectStack(localProgramArgs, wsOpts);

    return stack;
  }

  async removeStack(workDir: string, stackName: string): Promise<void> {
    const stack = await this.getStack(stackName, workDir);
    if (!stack) {
      this.logger.error(`Stack: ${stackName} not exist, please create it first!`);
      return;
    }

    await stack.workspace.removeStack(stackName);
  }

  async listStack(workDir: string, stackName: string): Promise<pulumiAuto.StackSummary> {
    const stack = await this.getStack(stackName, workDir);
    if (!stack) {
      this.logger.error(`Stack: ${stackName} not exist, please create it first!`);
      return;
    }

    const curStack = await stack.workspace.stack();
    return curStack;
  }

  async stack(inputs): Promise<void> {
    const {
      credentials,
      workDir,
      runtime,
      region,
      args,
      stackName,
      projectName,
      cloudPlatform } = await this.handlerInputs(inputs);
    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'stack',
        account: credentials.AccountID,
      },
    });
    this.logger.debug(`args: ${JSON.stringify(args)}`);
    const parsedArgs: {[key: string]: any} = core.commandParse({ args }, { boolean: ['s', 'silent'] });
    this.logger.debug(`parsedArgs: ${JSON.stringify(parsedArgs)}`);
    const nonOptionsArgs = parsedArgs.data?._;

    if (_.isEmpty(nonOptionsArgs)) {
      this.logger.error(' error: expects argument.');
      // help info
      return;
    }
    if (nonOptionsArgs.length > 1) {
      this.logger.error(` error: unexpected argument: ${nonOptionsArgs[1]}`);
      // help info
      return;
    }
    const subCmd: string = nonOptionsArgs[0];

    if (!await fse.pathExists(path.join(this.pulumiHome, 'credentials.json'))) {
      await this.loginPulumi(undefined, true);
    }

    switch (subCmd) {
      case 'init': {
        this.logger.info(`Initializing stack ${stackName} of project ${projectName}...`);
        const stack: pulumiAuto.Stack = await this.createStack(workDir, projectName, runtime, stackName);
        this.logger.info(`Stack ${stackName} of project ${projectName} created.`);
        if (cloudPlatform === 'alicloud') {
          await stack.setConfig('alicloud:secretKey', { value: credentials.AccessKeySecret, secret: true });
          await stack.setConfig('alicloud:accessKey', { value: credentials.AccessKeyID, secret: true });
          await stack.setConfig('alicloud:region', { value: region });
        }
        break;
      }
      case 'rm': {
        this.logger.info(`Removing stack ${stackName}...`);
        await this.removeStack(workDir, stackName);
        this.logger.info(`Stack ${stackName} of project ${projectName} removed.`);
        break;
      }
      case 'ls': {
        const curStack: pulumiAuto.StackSummary = await this.listStack(workDir, stackName);
        if (curStack) {
          this.logger.info(`Summary of stack ${stackName} is: `);
          this.logger.log(util.inspect(curStack, true, null, true), 'green');
        } else {
          this.logger.info(`Summary of stack ${stackName} is undefined.`);
        }

        break;
      }
      default: {
        this.logger.info(`Sorry, stack ${subCmd} is not supported for pulumi component`);
      }
    }
  }

  async up(inputs): Promise<any> {
    const {
      credentials,
      cloudPlatform,
      projectName,
      stackName,
      workDir,
      runtime,
      region,
      args } = await this.handlerInputs(inputs);

    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'up',
        account: credentials.AccountID,
      },
    });
    const parsedArgs: {[key: string]: any} = core.commandParse({ args }, { boolean: ['s', 'silent', 'local'] });
    this.logger.debug(`parsedArgs: ${JSON.stringify(parsedArgs)}`);
    const nonOptionsArgs = parsedArgs.data?._;

    const isSilent = parsedArgs.data?.s || parsedArgs.data?.silent;
    if (!_.isEmpty(nonOptionsArgs)) {
      this.logger.error(`error: unexpect argument ${nonOptionsArgs}`);
      // help info
      return;
    }
    if (!await fse.pathExists(path.join(this.pulumiHome, 'credentials.json'))) {
      await this.loginPulumi(undefined, true, isSilent);
    }
    const stack = await this.createStack(workDir, projectName, runtime, stackName);
    if (cloudPlatform === 'alicloud') {
      await stack.setConfig('alicloud:secretKey', { value: credentials.AccessKeySecret, secret: true });
      await stack.setConfig('alicloud:accessKey', { value: credentials.AccessKeyID, secret: true });
      await stack.setConfig('alicloud:region', { value: region });
    }

    // await runPulumiCmd(['import', 'alicloud:fc/service:Service' , 'import-test', 'python37-demo', '--yes', '--protect=false', `--stack ${stackName}`], process.cwd(), { PULUMI_HOME: this.pulumiHome, PULUMI_CONFIG_PASSPHRASE: this.pulumiConfigPassphrase }, console.log);
    await this.installPlugins(cloudPlatform, stackName, stack);
    try {
      const refreshRes = await stack.refresh({ onOutput: isSilent ? undefined : console.log });
      this.logger.debug(`refresh res: ${JSON.stringify(refreshRes)}`);
    } catch (e) {
      if (e.message.includes('unknown flag: --page-size')) {
        this.logger.error('Please update your pulumi cli and retry. Refer to https://www.pulumi.com/docs/get-started/install/');
        return;
      }
      throw e;
    }
    let res;
    try {
      res = await stack.up({ onOutput: isSilent ? undefined : console.log });
      if (!_.isEmpty(res?.stderr)) {
        if (res?.stderr.includes('unknown flag: --page-size')) {
          this.logger.error('Please update your pulumi cli and retry. Refer to https://www.pulumi.com/docs/get-started/install/');
          return;
        }
      }
    } catch (e) {
      if (e.message.includes('unknown flag: --page-size')) {
        this.logger.error('Please update your pulumi cli and retry. Refer to https://www.pulumi.com/docs/get-started/install/');
        return;
      }
      throw e;
    }

    // const his = await stack.history();
    // const output = await stack.outputs();

    return {
      stdout: res?.stdout,
      stderr: res?.stderr,
    };
  }

  async destroy(inputs): Promise<any> {
    const {
      credentials,
      cloudPlatform,
      stackName,
      workDir,
      region,
      args } = await this.handlerInputs(inputs);

    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'destroy',
        account: credentials.AccountID,
      },
    });
    const parsedArgs: {[key: string]: any} = core.commandParse({ args }, { boolean: ['s', 'silent', 'local'] });
    this.logger.debug(`parsedArgs: ${JSON.stringify(parsedArgs)}`);
    const nonOptionsArgs = parsedArgs.data?._;
    if (!_.isEmpty(nonOptionsArgs)) {
      this.logger.error(`error: unexpect argument ${nonOptionsArgs}`);
      // help info
      return;
    }
    const isSilent = parsedArgs.data?.s || parsedArgs.data?.silent;
    if (!await fse.pathExists(path.join(this.pulumiHome, 'credentials.json'))) {
      await this.loginPulumi(undefined, true, isSilent);
    }

    const stack = await this.getStack(stackName, workDir);

    if (!stack) {
      this.logger.error(`Stack: ${stackName} not exist, please create it first!`);
      return;
    }
    if (cloudPlatform === 'alicloud') {
      await stack.setConfig('alicloud:secretKey', { value: credentials.AccessKeySecret, secret: true });
      await stack.setConfig('alicloud:accessKey', { value: credentials.AccessKeyID, secret: true });
      await stack.setConfig('alicloud:region', { value: region });
    }

    await this.installPlugins(cloudPlatform, stackName, stack);

    let res;
    try {
      res = await stack.destroy({ onOutput: isSilent ? undefined : console.log });
      if (!_.isEmpty(res?.stderr)) {
        if (res?.stderr.includes('unknown flag: --page-size')) {
          this.logger.error('Please update your pulumi cli and retry. Refer to https://www.pulumi.com/docs/get-started/install/');
          return;
        }
      }
    } catch (e) {
      if (e.message.includes('unknown flag: --page-size')) {
        this.logger.error('Please update your pulumi cli and retry. Refer to https://www.pulumi.com/docs/get-started/install/');
        return;
      }
      throw e;
    }
    // await stack.workspace.removeStack(stackName);
    return {
      stdout: res?.stdout,
      stderr: res?.stderr,
    };
  }


  async installPlugins(cloudPlatform: string, stackName: string, stack: pulumiAuto.Stack): Promise<void> {
    const pkgName = `@pulumi/${cloudPlatform}`;
    const version = `v${getLatestVersionOfPackage(pkgName)}`;
    this.logger.info(`wating for plugin ${cloudPlatform}:${version} to be installed`);
    await stack.workspace.installPlugin(cloudPlatform, version);
  }

  readonly pulumiAlreadyExists: boolean;
  readonly pulumiDir: string;
  readonly pulumiHome: string;
  readonly pulumiBin: string;
  readonly pulumiPath: string;
  readonly pulumiConfigPassphrase: string;
  readonly pulumiEnvs: {
    [key: string]: string;
  };
}
