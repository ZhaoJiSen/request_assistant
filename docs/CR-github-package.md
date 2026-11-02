# GitHub 手动打包 CI 自审

日期：2026-11-02。范围：手动打包工作流、版本设置/ZIP 验证脚本、本地打包命令移除、原生弹窗测试路径和使用文档。

## 检查结论

- 仅 workflow_dispatch 触发，必填 version，版本在 env 中传入 Node，不直接拼接为 shell 代码。限制 X.Y.Z，每段0–65535、无前导零、不能全部为0，拒绝空白和预发布后缀。
- workflow 只申请 contents:read，checkout 不保留凭据；不提交版本修改，不写 tag/Release。输入只影响隔离 runner 里的 package.json、lockfile 与 WXT 自动读取的 manifest。
- 使用 npm ci 和现有锁文件安装依赖；类型检查和完整逻辑单测成功后才执行正式 WXT Chrome ZIP。ZIP 验证核对版本、Manifest V3、根目录入口、文件集合、逐字节内容和压缩包完整性。
- 上传单文件 ZIP，archive:false 避免套一层压缩包；找不到文件使工作流失败，保留30天。权限、包管理和版本输入不需要额外 secrets。
- 移除本地 package:local/zip 命令及复制安装目录脚本。保留 build/dev/preview/类型检查/测试；build 仅生成 .output/chrome-mv3，不生成 ZIP。原生弹窗测试改为与其他浏览器测试相同的 .output/chrome-mv3-dev，未删除用户既有安装目录或配置。
- 候选值搜索与别名的上一轮实现已单独提交，且包含对应 CR 报告；本次仅提交 CI 相关文件。

## 验证

本地只运行类型检查、CI版本校验/元数据更新单测与工作流静态检查，不执行构建或ZIP打包。实际打包在GitHub运行验证，版本使用当前2.1.0；运行与结果见任务交付链接。

2026-11-02 补充：根据用户反馈恢复此前一并移除的 build 命令。仅恢复 npm 脚本并更新说明，JSON 解析与脚本值检查通过；未执行本地构建或 ZIP 打包。
