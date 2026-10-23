# MP 工具详细用法

## 工具：`mp_lookup`

按化学式 / MP ID / 化学体系取回材料物性，重点是**空间群**。

### 参数

必填三选一：`formula` / `material_ids` / `chemsys`。

| 参数 | 默认 | 说明 |
|---|---|---|
| `formula` | — | 化学式，如 `VFeAs`；逗号分隔批量；支持通配符 |
| `material_ids` | — | `mp-1095040` 或新式 ID；逗号分隔 |
| `chemsys` | — | 化学体系，如 `V-Fe-As`；支持 `*-Ru-P` |
| `fields` | `core` | 额外字段组，见下 |
| `experimental_only` | `false` | 只返回实验结构（`theoretical=false`） |
| `stable_only` | `false` | 只返回 `energy_above_hull=0` |
| `metal_only` | `false` | 只返回金属 |
| `max_rows` | `30` | 表格最多几行 |
| `full_props` | `false` | `has_props` 是否展开全部 20 项 |
| `save` | `true` | 原始 JSON 是否落盘 |
| `key_file` | 配置值 | 覆盖 key 文件路径（一般不用） |

### 字段组

`core`（永远带）、`thermo`、`electronic`、`magnetism`、`elastic`、`structure`、`surface`、`props`、`all`，以及需要另打端点的 `debye`、`synthesis`、`robocrys`、`phonon`、`similarity`、`provenance`、`electronic_full`、`magnetism_full`、`thermo_full`。

---

## 工具：`mp_spacegroup`

按空间群 / 晶系做普查筛选。至少给 `spacegroup_number` / `spacegroup_symbol` / `crystal_system` 之一。

额外参数：

| 参数 | 说明 |
|---|---|
| `chemsys` | 化学体系；支持通配符，但一次只能一个体系 |
| `elements` / `exclude_elements` | 必须包含 / 排除的元素 |
| `formula` | 化学式过滤 |
| `nelements` | 元素数 |
| `sort` | 排序字段，前缀 `-` 降序 |
| `limit` / `page` | 分页，1–1000 / 从 1 开始 |

---

## 凭据优先级

1. 工具参数 `key_file`；
2. DSH 凭据 `DSH_MP_API_KEY`（设置页写入）；
3. 环境变量 `MP_API_KEY`；
4. 文件 `<dataDir>/api_key.txt`。

---

## 使用习惯

- 默认习惯见 [HABITS.md](HABITS.md)。
- 修改：在对话里口述，DSH 调用 `mp_habits(action="write", content="...")`。
- 读取 / 重置：`mp_habits(action="read")` / `mp_habits(action="reset")`。
- 文档位置：`<dataDir>/habits.md`（dataDir 默认 `$DSH_HOME/storages/mp-fetch`，可在设置页改）。
- 系统提示每条消息动态读取；保存后下一条消息生效。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **没有 Tc** | MP 不含超导临界温度，也不含电声耦合常数；Tc 必须查 WoS。 |
| **phonon 不给稳定性** | `/materials/phonon/` 只给计算元信息，实测频率/能带字段为 null；有记录 ≠ 稳定。 |
| **`_fields` 必须显式写** | 不写时只返回 `material_id`；插件内部已处理。 |
| **phonon 端点用 identifiers** | 它接受 `formula` 反查，不接受 `material_ids`；插件内部已处理。 |
| **synthesis 不支持 `_fields`** | 传了会被拒；插件内部已处理。 |
| **点群不能当筛选项** | 要按点群筛，先按空间群查再本地过滤。 |
| **体系通配符仅单体系** | `*-Ru-P` 可以；`*-Ru-P,*-Fe-P` 会被拦下。 |
| **ID 有两套** | 默认返回新 ID；插件带 `id_format=legacy`，回吐 `mp-1095040` 这类 ID。 |
| **MP 无条目 ≠ 相不存在** | 收录有限；查不到时与用户核对。 |

---

## 限流

```
25/秒 · 1000/分 · 40000/时 · 640000/天
```

官方文档写明“25 次/秒起”；以上为插件实测响应头。响应头 `X-RateLimit-Remaining-*` 实时回报余量，工具输出末尾显示本秒/本小时余量。撞到 429 时按 `RateLimit-Reset` 退避重试（最多 2 次）。
