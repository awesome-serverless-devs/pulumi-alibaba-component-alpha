import { Component } from '@serverless-devs/s-core';
import * as pulumiAuto from '@pulumi/pulumi/x/automation';
import * as path from 'path';
import * as uuid from 'uuid';
import * as os from 'os';
import * as fse from 'fs-extra';
import commandExists from 'command-exists';
import * as shell from 'shelljs';
import { HLogger, ILogger, report } from '@serverless-devs/core';
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

export default class PulumiComponent extends Component {
  @HLogger('S-CORE') logger: ILogger;
  constructor() {
    super();
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
  async handlerInputs(inputs) {
    await this.init();
    const state = this.state || {};
    // @ts-ignore
    if (state.projectName) {
      inputs.Properties = inputs.Properties || {};
      // @ts-ignore
      inputs.Properties.projectName = inputs.Properties.projectName || state.projectName;
    }
    // @ts-ignore
    if (state.stackName) {
      inputs.Properties = inputs.Properties || {};
      // @ts-ignore
      inputs.Properties.stackName = inputs.Properties.stackName || state.stackName;
    }
    const prop = inputs.Properties || {};
    const creds = inputs.Credentials || {};
    const serverlessDevsProject = inputs.Project || {};
    const args = this.args(inputs.Args);
    const serverlessDevsProjectName = serverlessDevsProject.ProjectName;
    const provider = serverlessDevsProject.Provider;
    // @ts-ignore
    const projectName = prop.projectName || state.projectName || `pulumi-default-${serverlessDevsProjectName}-project-${uuid.v4()}`;
    // @ts-ignore
    const stackName = prop.stackName || state.stackName || `pulumi-default-${serverlessDevsProjectName}-stack-${uuid.v4()}`;

    this.state = {
      projectName,
      stackName,
    };
    this.save();

    const workDir = prop.workDir || DEFAULT.workDir;
    const runtime: pulumiAuto.ProjectRuntime = prop.runtime || DEFAULT.runtime;
    const region = prop.region || DEFAULT.region;
    const { cloudPlatform } = prop;

    if (!cloudPlatform || (SUPPORTED_CLOUD_PLATFORMS.indexOf(cloudPlatform) < 0)) {
      this.logger.error(`${cloudPlatform} not supported now, supported cloud platform includes ${SUPPORTED_CLOUD_PLATFORMS}`);
      throw new Error(`${cloudPlatform} not supported now, supported cloud platform includes ${SUPPORTED_CLOUD_PLATFORMS}`);
    }

    return {
      creds,
      provider,
      projectName,
      stackName,
      workDir,
      runtime,
      region,
      args,
      cloudPlatform,
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
    const { args, creds } = await this.handlerInputs(inputs);

    await report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'login',
        account: creds.AccountID,
      },
    });
    await this.loginPulumi(args.Commands[0]);
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

    this.state = {};
    this.save();
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
      creds,
      projectName,
      stackName,
      workDir,
      runtime,
      region,
      args } = await this.handlerInputs(inputs);
    await report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'stack',
        account: creds.AccountID,
      },
    });
    const commands = args.Commands;

    await this.loginPulumi();

    switch (commands[0]) {
      case 'init': {
        this.logger.log(`Initializing stack ${stackName} of project ${projectName}...`, 'yellow');
        const stack: pulumiAuto.Stack = await this.createStack(workDir, projectName, runtime, stackName);
        this.logger.log(`Stack ${stackName} of project ${projectName} created.`, 'green');
        await stack.setConfig('alicloud:secretKey', { value: creds.AccessKeySecret, secret: true });
        await stack.setConfig('alicloud:accessKey', { value: creds.AccessKeyID, secret: true });
        await stack.setConfig('alicloud:region', { value: region });
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
      creds,
      cloudPlatform,
      projectName,
      stackName,
      workDir,
      runtime,
      region } = await this.handlerInputs(inputs);

    await report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'up',
        account: creds.AccountID,
      },
    });
    await this.loginPulumi();
    const stack = await this.createStack(workDir, projectName, runtime, stackName);

    await stack.setConfig('alicloud:secretKey', { value: creds.AccessKeySecret, secret: true });
    await stack.setConfig('alicloud:accessKey', { value: creds.AccessKeyID, secret: true });
    await stack.setConfig('alicloud:region', { value: region });

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
      creds,
      cloudPlatform,
      stackName,
      workDir,
      region } = await this.handlerInputs(inputs);

    await report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'destroy',
        account: creds.AccountID,
      },
    });
    await this.loginPulumi();
    const stack = await this.getStack(stackName, workDir);

    if (!stack) {
      this.logger.log(`Stack: ${stackName} not exist, please create it first!`, 'red');
      return;
    }
    await stack.setConfig('alicloud:secretKey', { value: creds.AccessKeySecret, secret: true });
    await stack.setConfig('alicloud:accessKey', { value: creds.AccessKeyID, secret: true });
    await stack.setConfig('alicloud:region', { value: region });

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
