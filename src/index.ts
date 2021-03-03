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

const { runPulumiCmd } = require('@pulumi/pulumi/x/automation/cmd');

const DEFAULT = {
  region: 'cn-hangzhou',
  workDir: '.',
  runtime: 'nodejs',
  pulumiHome: path.join(os.homedir(), '.pulumi'),
};

const SUPPORTED_CLOUD_PLATFORMS = ['alicloud'];

export default class PulumiComponent {
  @core.HLogger('S-CORE') logger: core.ILogger;
  constructor() {
    if (fse.pathExistsSync(DEFAULT.pulumiHome) && commandExists.sync('pulumi')) {
      // pulumi cli exists
      this.pulumiDir = path.dirname(DEFAULT.pulumiHome);
      this.pulumiHome = DEFAULT.pulumiHome;
      this.pulumiAlreadyExists = true;
    } else {
      this.pulumiDir = path.join(__dirname, 'utils', 'pulumi');
      this.pulumiHome = path.join(this.pulumiDir, '.pulumi');
      this.pulumiBin = path.join(this.pulumiHome, 'bin');
      this.pulumiPath = path.join(this.pulumiBin, 'pulumi');

      if (!fse.pathExistsSync(this.pulumiPath)) {
        shell.exec(`node ${path.join(this.pulumiDir, 'install.js')}`);
      }
      this.pulumiAlreadyExists = false;
    }

    this.pulumiConfigPassphrase = 'password';
    this.logger.log(`PULUMI_CONFIG_PASSPHRASE is ${this.pulumiConfigPassphrase}`, 'yellow');

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
  handlerInputs(inputs) {
    const prop = inputs?.Properties || inputs?.properties;
    const credentials = inputs?.Credentials || inputs?.credentials;
    const serverlessDevsProject = inputs?.Project || inputs?.project;
    const args = inputs?.Args || inputs?.args;

    let parsedArgs;
    if (args) {
      parsedArgs = core.commandParse({ args });
    }

    const provider = serverlessDevsProject?.Provider || serverlessDevsProject?.provider;

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
      provider,
      workDir,
      runtime,
      region,
      parsedArgs,
      cloudPlatform,
      stackName,
      projectName,
    };
  }

  async loginPulumi(url?: string): Promise<void> {
    if (url) {
      // @ts-ignore
      await runPulumiCmd(['login', url], process.cwd(), this.pulumiEnvs, console.log);
    } else {
      // login local
      await runPulumiCmd(['login', `file://${this.pulumiDir}`], process.cwd(), this.pulumiEnvs, console.log);
    }
  }


  async login(inputs): Promise<void> {
    const { parsedArgs, credentials } = this.handlerInputs(inputs);

    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'login',
        account: credentials.AccountID,
      },
    });
    const argsData = parsedArgs.data;
    await this.loginPulumi(argsData._[0]);
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
      this.logger.log(`Stack: ${stackName} not exist, please create it first!`, 'red');
      return;
    }

    await stack.workspace.removeStack(stackName);
  }

  async listStack(workDir: string, stackName: string): Promise<pulumiAuto.StackSummary> {
    const stack = await this.getStack(stackName, workDir);
    if (!stack) {
      this.logger.log(`Stack: ${stackName} not exist, please create it first!`, 'red');
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
      parsedArgs,
      stackName,
      projectName,
      cloudPlatform } = this.handlerInputs(inputs);
    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'stack',
        account: credentials.AccountID,
      },
    });
    const commands = parsedArgs.data._;
    if (!await fse.pathExists(path.join(this.pulumiHome, 'credentials.json'))) {
      await this.loginPulumi();
    }

    switch (commands[0]) {
      case 'init': {
        this.logger.log(`Initializing stack ${stackName} of project ${projectName}...`, 'yellow');
        const stack: pulumiAuto.Stack = await this.createStack(workDir, projectName, runtime, stackName);
        this.logger.log(`Stack ${stackName} of project ${projectName} created.`, 'green');
        if (cloudPlatform === 'alicloud') {
          await stack.setConfig('alicloud:secretKey', { value: credentials.AccessKeySecret, secret: true });
          await stack.setConfig('alicloud:accessKey', { value: credentials.AccessKeyID, secret: true });
          await stack.setConfig('alicloud:region', { value: region });
        }
        break;
      }
      case 'rm': {
        this.logger.log(`Removing stack ${stackName}...`, 'yellow');
        await this.removeStack(workDir, stackName);
        this.logger.log(`Stack ${stackName} of project ${projectName} removed.`, 'green');
        break;
      }
      case 'ls': {
        const curStack: pulumiAuto.StackSummary = await this.listStack(workDir, stackName);
        if (curStack) {
          this.logger.log(`Summary of stack ${stackName} is: `, 'green');
          console.log(util.inspect(curStack, true, null, true));
        } else {
          this.logger.log(`Summary of stack ${stackName} is undefined.`, 'red');
        }

        break;
      }
      default: {
        this.logger.log(`Sorry, stack ${commands[0]} is not supported for pulumi component`, 'red');
      }
    }
  }

  async up(inputs): Promise<string> {
    const {
      credentials,
      cloudPlatform,
      projectName,
      stackName,
      workDir,
      runtime,
      region } = this.handlerInputs(inputs);

    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'up',
        account: credentials.AccountID,
      },
    });
    if (!await fse.pathExists(path.join(this.pulumiHome, 'credentials.json'))) {
      await this.loginPulumi();
    }
    const stack = await this.createStack(workDir, projectName, runtime, stackName);
    if (cloudPlatform === 'alicloud') {
      await stack.setConfig('alicloud:secretKey', { value: credentials.AccessKeySecret, secret: true });
      await stack.setConfig('alicloud:accessKey', { value: credentials.AccessKeyID, secret: true });
      await stack.setConfig('alicloud:region', { value: region });
    }

    // await runPulumiCmd(['import', 'alicloud:fc/service:Service' , 'import-test', 'python37-demo', '--yes', '--protect=false', `--stack ${stackName}`], process.cwd(), { PULUMI_HOME: this.pulumiHome, PULUMI_CONFIG_PASSPHRASE: this.pulumiConfigPassphrase }, console.log);
    await this.installPlugins(cloudPlatform, stackName, stack);

    await stack.refresh({ onOutput: console.log });

    const upRes = await stack.up({ onOutput: console.log });
    // const his = await stack.history();
    // const output = await stack.outputs();

    return upRes.stdout;
  }

  async destroy(inputs): Promise<string> {
    const {
      credentials,
      cloudPlatform,
      stackName,
      workDir,
      region } = this.handlerInputs(inputs);

    await core.report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'destroy',
        account: credentials.AccountID,
      },
    });
    if (!await fse.pathExists(path.join(this.pulumiHome, 'credentials.json'))) {
      await this.loginPulumi();
    }
    const stack = await this.getStack(stackName, workDir);

    if (!stack) {
      this.logger.log(`Stack: ${stackName} not exist, please create it first!`, 'red');
      return;
    }
    if (cloudPlatform === 'alicloud') {
      await stack.setConfig('alicloud:secretKey', { value: credentials.AccessKeySecret, secret: true });
      await stack.setConfig('alicloud:accessKey', { value: credentials.AccessKeyID, secret: true });
      await stack.setConfig('alicloud:region', { value: region });
    }

    await this.installPlugins(cloudPlatform, stackName, stack);

    const destroyRes = await stack.destroy({ onOutput: console.log });
    // await stack.workspace.removeStack(stackName);

    return destroyRes.stdout;
  }


  async installPlugins(cloudPlatform: string, stackName: string, stack: pulumiAuto.Stack): Promise<void> {
    const pkgName = `@pulumi/${cloudPlatform}`;
    const version = `v${getLatestVersionOfPackage(pkgName)}`;
    this.logger.log(`Installing plugin ${cloudPlatform}:${version}`, 'yellow');
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
