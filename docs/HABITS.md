# 课题组 MP 使用习惯（默认）

1. 空间群严格以 `mp_lookup` / `mp_spacegroup` 返回值为准，不凭印象或旧文档。
2. 化学式多试元素顺序；MP 会重排（ScRuP → ScPRu）。
3. 先 `mp_lookup` 定空间群，再 `mp_spacegroup` 按空间群普查同族材料。
4. 超导候选默认 `metal_only` + `stable_only` + `experimental_only` 三件套。
5. MP 没有 Tc，也没有电声耦合常数；Tc 必须查 WoS 文献。
6. `chemsys` 通配符一次只能查一个体系，不能和逗号列表一起用。
7. MP 查不到条目时先与用户核对，不要自行判定“不存在”。
8. 限流：25/秒 · 1000/分 · 40000/时 · 640000/天；工具会显示余量并对 429 退避。

---

> 这份文件是出厂默认值。实际生效的是 `$DSH_HOME/storages/mp-fetch/habits.md`；
> 在对话里让 DSH 调用 `mp_habits(action="write")` 即可按个人习惯覆盖。
