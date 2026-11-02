# 云端打包自动发布 Release 检查

2026-11-02。

## 问题与改动

原 workflow 只有构建和上传 Actions artifact，且 contents 为只读，所以打包成功不会创建 Release。已确认旧的 2.2.0 运行 41439705528 成功，但仓库尚无对应版本标签和 Release。

- 保留手动输入版本号、依赖安装、类型检查、单元测试、构建和 ZIP 内容校验。
- 打包 job 赋予 contents:write，仅版本检查和发布步骤显式传入内置 github.token，不需要新增个人令牌或 secrets。
- 检查通过且 ZIP 备份上传成功后，使用 gh release create 创建正式 Release，附加经过校验的 ZIP，生成发布说明；v<版本号> 标签显式指向本次运行的 GITHUB_SHA。
- 版本号先经过既有严格数字校验，以环境变量传递给 shell，参数使用引号。
- 构建前检查精确版本标签是否存在；API 失败直接终止，已有标签不覆盖。同版本运行串行执行，发布失败不会写出成功下载摘要。
- README 和运行摘要更新为 Release 下载入口，Actions 备份仍保留 30 天。

## 本地验证

- actionlint 与 git diff --check 通过。
- 37 项单元测试通过，含版本输入校验和 package/lock 版本一致性检查。
- 已核对 GitHub 官方 gh release create、GITHUB_TOKEN 权限及 matching-refs API 文档。
- 本次仅修改发布配置和说明，未修改插件代码、依赖或版本，未本地生成 ZIP。由主 Agent 检查，未独立评审。

云端端到端发布待推送后验证，尚未据本地检查宣称 Release 创建成功。
