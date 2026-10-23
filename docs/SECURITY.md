# 安全与凭据

## API key 存在哪

- 首选：DSH 凭据库 `$DSH_HOME/.credentials.yaml` 的 `refs.DSH_MP_API_KEY`。
- 回退：`<dataDir>/api_key.txt`（默认 `$DSH_HOME/storages/mp-fetch/api_key.txt`）。
- 优先级：工具参数 `key_file` > 凭据库 > 环境变量 `MP_API_KEY` > 文件。

## 不会发生什么

- 不会把 key 写进插件包、`cordis.patch.yml`、工具输出或日志。
- 不会把 key 发给 Materials Project 以外的域名。
- 设置页不会回显已保存的 key，只显示“已配置/未配置”和来源。

## 注意事项

- key 等同于密码：不要发给别人、不要提交到 git、不要贴进对话。
- 如果怀疑泄露：到 <https://next-gen.materialsproject.org/dashboard> 重置 key，然后在设置页保存新 key。
- 卸载插件不会自动删除凭据；需要时在设置页点“清除”，或手动编辑 `.credentials.yaml`。
- `$DSH_HOME/.credentials.yaml` 的权限应为仅当前用户可读（DSH 会检查）。
