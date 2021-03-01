## 前言

pulumi 组件基于 [pulumi automation api](https://www.pulumi.com/blog/automation-api/) 实现。

## 示例运行

目录 [examples](./examples) 下有运行示例，可以按照以下步骤来运行示例代码来部署函数资源。

```shell

rm -rf dist
npm run dev

cd examples/deploy_fc && npm i
```

上述指令执行完成后，将当前项目下的 dist 目录的绝对路径填写至 [examples/deploy_fc/s.yaml](./examples/deploy_fc/s.yaml) 中的 component 字段，然后执行 ```s up ```指令即可。