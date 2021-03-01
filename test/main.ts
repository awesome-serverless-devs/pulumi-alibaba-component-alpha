import * as shell from 'shelljs';

export function getLatestVersionOfPackage(pkgName) {
  const version = shell.exec(`npm show ${pkgName} version`, {silent:true}).stdout;
  // 去掉第二行的空行
  return version.split('\n')[0];
}