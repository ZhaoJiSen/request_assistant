# 顶部信息归并检查

- 只调整popup顶部结构、样式及环境管理入口，不修改后台、权限、规则或Cookie数据格式。
- 顶部保留字标、环境切换、总开关、域名及匹配数。移除卡片与辅助图标；暂停有明确文字，异常仍显示原有alert。
- 管理环境移入UiSelect现有footer；补齐非搜索选择器Tab到footer、Shift+Tab返回触发器的路径，保留搜索选择器已有逻辑。通过键盘真实操作验证Tab、Shift+Tab和Enter打开管理页。
- 类型检查通过；长环境名、域名及暂停状态在480px宽度下不产生横向溢出，环境选择器最大180px，总开关右边界460px；查看正常截图及2倍像素局部。
- 10项Chrome环境回归通过，包含下拉管理入口的Tab/Enter、环境切换与实际请求隔离、Cookie保留、刷新读回、失败输入保留、暂停切组及短视口菜单。新增原生按钮键盘用例时，旧CDP辅助函数缺少Enter虚拟键码，导致默认按钮激活未触发；补齐真实Enter事件字段后通过，产品按钮继续使用原生激活。
- 本轮为局部低风险整理，主Agent自检，未另派独立评审。未重新生成生产ZIP。

截图：`evidence/header-simplify/header.png`、`long-paused-2x.png`。环境回归证据沿用脚本输出目录`evidence/environment-groups`。
