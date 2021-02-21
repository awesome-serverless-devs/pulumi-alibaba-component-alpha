import { Component } from '@serverless-devs/s-core';
import * as pulumiAuto from '@pulumi/pulumi/x/automation';
import * as path from 'path';
import * as uuid from 'uuid';
import * as providerPluginJson from './config/provider-plugin.json';
import * as os from 'os';
import * as fse from 'fs-extra';
import commandExists from 'command-exists';
import * as shell from 'shelljs';
import { HLogger, ILogger, report } from '@serverless-devs/core';
import * as util from 'util';

const { runPulumiCmd } = require('@pulumi/pulumi/x/automation/cmd');

const DEFAULT = {
  region: 'cn-hangzhou',
  workDir: '.',
  runtime: 'nodejs',
  pulumiHome: path.join(os.homedir(), '.pulumi'),
};


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

    if (runtime !== 'nodejs') {
      this.logger.error('pulumi component only supports nodejs now!');
      throw new Error('pulumi component only supports nodejs now!');
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
    };
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
    // @ts-ignore
    await runPulumiCmd(['login', args.Commands[0]], process.cwd(), this.pulumiEnvs, console.log);
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

    await this.login({ Credentials: creds, Args: `file://${this.pulumiDir}` });

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
      provider,
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
    await this.login({ Credentials: creds, Args: `file://${this.pulumiDir}` });
    const stack = await this.createStack(workDir, projectName, runtime, stackName);

    await stack.setConfig('alicloud:secretKey', { value: creds.AccessKeySecret, secret: true });
    await stack.setConfig('alicloud:accessKey', { value: creds.AccessKeyID, secret: true });
    await stack.setConfig('alicloud:region', { value: region });

    // await runPulumiCmd(['import', 'alicloud:fc/service:Service' , 'import-test', 'python37-demo', '--yes', '--protect=false', `--stack ${stackName}`], process.cwd(), { PULUMI_HOME: this.pulumiHome, PULUMI_CONFIG_PASSPHRASE: this.pulumiConfigPassphrase }, console.log);
    await this.installPlugins(provider, stackName, stack);

    await stack.refresh({ onOutput: console.log });

    const upRes = await stack.up({ onOutput: console.log });
    // const his = await stack.history();
    // console.log("=======");
    // console.dir(his);
    // const output = await stack.outputs();

    return upRes.stdout;
  }

  async destroy(inputs): Promise<string> {
    const {
      creds,
      provider,
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
    await this.login({ Credentials: creds, Args: `file://${this.pulumiDir}` });
    const stack = await this.getStack(stackName, workDir);

    if (!stack) {
      this.logger.log(`Stack: ${stackName} not exist, please create it first!`, 'red');
      return;
    }
    await stack.setConfig('alicloud:secretKey', { value: creds.AccessKeySecret, secret: true });
    await stack.setConfig('alicloud:accessKey', { value: creds.AccessKeyID, secret: true });
    await stack.setConfig('alicloud:region', { value: region });

    await this.installPlugins(provider, stackName, stack);

    const destroyRes = await stack.destroy({ onOutput: console.log });
    // await stack.workspace.removeStack(stackName);

    return destroyRes.stdout;
  }


  async installPlugins(provider: string, stackName: string, stack: pulumiAuto.Stack): Promise<void> {
    const pluginConfig = providerPluginJson[`${provider}`];
    if (pluginConfig) {
      this.logger.log(`Installing plugin ${pluginConfig.name}:${pluginConfig.version}`, 'yellow');
      await stack.workspace.installPlugin(pluginConfig.name, pluginConfig.version);
    } else {
      console.log(`destroy and remove stack ${stackName}`);
      await stack.destroy();
      await stack.workspace.removeStack(stackName);
      throw new Error(`Plugin of provider: ${provider} not support now!`);
    }
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
