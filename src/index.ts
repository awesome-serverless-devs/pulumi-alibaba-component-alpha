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
    this.pulumiEnvs = {
      PULUMI_CONFIG_PASSPHRASE: this.pulumiConfigPassphrase,
      PULUMI_SKIP_UPDATE_CHECK: true,
      PULUMI_ENABLE_LEGACY_PLUGIN_SEARCH: false,
      PULUMI_SKIP_CONFIRMATIONS: true,
    };
  }

  // 解析入参
  handlerInputs(inputs) {
    const prop = inputs.Properties || {};
    const creds = inputs.Credentials || {};
    const args = inputs.Args;
    const serverlessDevsProjectName = inputs.Project.ProjectName;
    const provider = inputs.Project.Provider;

    const projectName = prop.projectName || `pulumi-default-${serverlessDevsProjectName}-project-${uuid.v4()}`;
    const stackName = prop.stackName || `pulumi-default-${serverlessDevsProjectName}-stack-${uuid.v4()}`;
    const workDir = prop.workDir || DEFAULT.workDir;
    const runtime = prop.runtime || DEFAULT.runtime;
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

  async login(inputs) {
    const { args, creds } = this.handlerInputs(inputs);
    await report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'login',
        account: creds.AccountID,
      },
    });
    // @ts-ignore
    await runPulumiCmd(['login', args], process.cwd(), { PULUMI_HOME: this.pulumiHome }, console.log);
  }


  async up(inputs) {
    await this.init();
    const state = this.state || {};
    if (state.projectName) {
      inputs.Properties = inputs.Properties || {};
      inputs.Properties.projectName = state.projectName;
    }
    if (state.stackName) {
      inputs.Properties = inputs.Properties || {};
      inputs.Properties.stackName = state.stackName;
    }

    const {
      creds,
      provider,
      projectName,
      stackName,
      workDir,
      runtime,
      region } = this.handlerInputs(inputs);

    await report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'up',
        account: creds.AccountID,
      },
    });
    if (!this.pulumiAlreadyExists) {
      process.env.PATH = `${process.env.PATH }:${this.pulumiBin}`;
    }

    const loginArgs = { Args: `file://${this.pulumiDir}` };
    await this.login({ ...inputs, ...loginArgs });

    const envVars = { ...process.env, ...this.pulumiEnvs };

    const wpOpts: pulumiAuto.LocalWorkspaceOptions = {
      workDir,
      pulumiHome: this.pulumiHome,
      envVars,
      projectSettings: {
        name: projectName,
        runtime,
      },
    };

    this.state = {
      wpOpts,
      projectName,
      stackName,
    };
    this.save();

    // const inlineProgramArgs: pulumiAuto.InlineProgramArgs = {
    //   stackName,
    //   projectName,
    //   program: p()
    // };
    const localProgramArgs: pulumiAuto.LocalProgramArgs = {
      stackName,
      workDir,
    };
    const stack = await pulumiAuto.LocalWorkspace.createOrSelectStack(localProgramArgs, wpOpts);

    await stack.setConfig('alicloud:secretKey', { value: creds.AccessKeySecret, secret: true });
    await stack.setConfig('alicloud:accessKey', { value: creds.AccessKeyID, secret: true });
    await stack.setConfig('alicloud:region', { value: region });

    await this.installPlugins(provider, stackName, stack);

    await stack.refresh({ onOutput: console.log });

    const upRes = await stack.up({ onOutput: console.log });
    // const output = await stack.outputs();

    return upRes.stdout;
  }

  async destroy(inputs) {
    await this.init();
    const state = this.state || {};
    // @ts-ignore
    const { wpOpts } = state;
    if (state.stackName) {
      inputs.Properties = inputs.Properties || {};
      inputs.Properties.stackName = state.stackName;
    }
    const {
      creds,
      provider,
      stackName,
      workDir } = this.handlerInputs(inputs);

    await report('组件调用', {
      type: 'component',
      context: 'pulumi',
      params: {
        action: 'up',
        account: creds.AccountID,
      },
    });

    const LocalProgramArgs: pulumiAuto.LocalProgramArgs = {
      stackName,
      workDir,
    };
    const stack = await pulumiAuto.LocalWorkspace.selectStack(LocalProgramArgs, wpOpts);
    if (!stack) {
      this.logger.log(`Stack: ${stackName} not exist, please execute up command first!`, 'red');
      return;
    }
    await stack.setConfig('alicloud:secretKey', { value: creds.AccessKeySecret, secret: true });
    await stack.setConfig('alicloud:accessKey', { value: creds.AccessKeyID, secret: true });

    await this.installPlugins(provider, stackName, stack);

    const destroyRes = await stack.destroy({ onOutput: console.log });
    // await stack.workspace.removeStack(stackName);

    return destroyRes.stdout;
  }


  async installPlugins(provider: string, stackName: string, stack: pulumiAuto.Stack) {
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
  readonly pulumiEnvs: object;
}
