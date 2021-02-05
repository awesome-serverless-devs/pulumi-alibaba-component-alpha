import * as commandExists from 'command-exists';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as rimraf from 'rimraf';
import { Logger, downloadRequest } from '@serverless-devs/core';

const VERSION = '2.19.0';

async function install() {
  // 判断 pulumi 是否存在
  if (commandExists.sync('pulumi')) {
    Logger.log('pulumi exist!');
    return;
  }
  // 判断平台
  if (process.platform === 'win32' && process.arch === 'x64') {
    Logger.log('Windows not supported now!Please install it manually.', 'red');
  } else if ((process.platform === 'darwin' || process.platform === 'linux') && process.arch === 'x64') {
    // const tarballUrl = `https://get.pulumi.com/releases/sdk/pulumi-v${VERSION}-${process.platform}-x64.tar.gz`;
    const tarballUrl = 'https://serverless-tool.oss-cn-hangzhou.aliyuncs.com/others/pulumi-alibaba-component/pulumi-v2.19.0-darwin-x64.tar.gz?versionId=CAEQFRiBgMD7hsDAuxciIDczZWRiZjI4NzVlNjRkMjc4MjA0MDE4YWM0MTc0Mjli';
    const dest = path.join(__dirname, 'pulumi.tar.gz');
    if (await fse.pathExists(dest)) {
      await fse.unlink(dest);
    }
    Logger.log(`Installing Pulumi v${VERSION} from ${tarballUrl}...`, 'yellow');
    const pulumiHome = path.join(__dirname, '.pulumi');
    const tmpDir = path.join(__dirname, '.pulumiTmp/');
    if (await fse.pathExists(pulumiHome)) { rimraf.sync(pulumiHome); }
    if (await fse.pathExists(tmpDir)) { rimraf.sync(tmpDir); }

    await fse.mkdirp(pulumiHome);
    await fse.mkdirp(tmpDir);

    await downloadRequest(tarballUrl, tmpDir, { extract: true });

    const tmpPulumiDir = path.join(tmpDir, 'pulumi');
    const tmpPulumiBinDir = path.join(tmpPulumiDir, 'bin');
    if (await fse.pathExists(tmpPulumiBinDir) && (await fse.lstat(tmpPulumiBinDir)).isDirectory()) {
      await fse.move(tmpPulumiBinDir, pulumiHome);
    } else {
      await fse.mkdirp(path.join(pulumiHome, 'bin'));
      await fse.copy(tmpPulumiDir, path.join(pulumiHome, 'bin'));
    }

    rimraf.sync(tmpDir);
  } else {
    Logger.log("We're sorry, but it looks like Pulumi is not supported on your platform! More infomation please refer to https://github.com/pulumi/pulumi", 'red');
  }
}

(async () => {
  try {
    await install();
    Logger.log('----Pulumi installed!----', 'green');
  } catch (e) {
    console.error('Error happend while installing pulumi: ', e.message);
  }
})();
