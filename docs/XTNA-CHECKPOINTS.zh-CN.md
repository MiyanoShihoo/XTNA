# 调查检查点

`npm run checkpoint -- <命令>` 把一次调查依赖的文件——Evidence 包与符号覆盖层——冻结进一个
带哈希清单的内容寻址目录。

恢复时**先校验每个文件的哈希再写入**,所以检查点不可能悄悄还原出不同的字节。

它快照的是你指定的文件,不是运行中的进程、容器或目标内存。

## 命令

```bash
npm run checkpoint -- create --name "session-12" --evidence .verify/evidence.json --overlay-dir ~/.xtna/overlays
npm run checkpoint -- branch --id cp_xxx --name "alternate-branch"
npm run checkpoint -- list

# 按源路径与哈希对比两个检查点
npm run checkpoint -- diff --from cp_xxx --to cp_yyy
npm run checkpoint -- diff --from cp_xxx --to cp_yyy --json

# 记录当时的进程/容器(只是观察,不可恢复)
npm run checkpoint -- create --name "with-procs" --evidence ev.json --processes
npm run checkpoint -- create --name "from-file" --evidence ev.json --processes-from snapshot.json
npm run checkpoint -- restore --id cp_xxx --dest-dir ./restored --overlay-dir ./restored/overlays
npm run checkpoint -- show --id cp_xxx
npm run checkpoint -- delete --id cp_xxx
```

## 差异视图

`diff` 按原始源路径配对两份清单并比较 SHA-256:

| 分类      | 含义                               |
| --------- | ---------------------------------- |
| `added`   | 只在新检查点中出现的源             |
| `removed` | 只在旧检查点中出现的源             |
| `changed` | 源相同但哈希不同(同时给出前后哈希) |
| 未变      | 源与哈希都相同(只计数,不逐条列出)  |

Evidence 与覆盖层分开对比;`--json` 输出的结构与人类可读输出同源。

## 进程与容器观察

`--processes` 现场采集进程表(Windows `tasklist`,POSIX `ps`)并询问 `docker ps`;`--processes-from <snapshot.json>`
则写入别处采集好的快照。数据落在 `manifest.json` 的 `processes` 中,含 `capturedAt`、`platform`、
`processes[]`、`containers[] | null` 与明确的限制说明。

这是**证据,不是状态**:restore 只写文件,不会重建进程或容器。`containers` 为 `null` 表示运行时没应答——
是未知,不是空。

## 行为要点

- **防篡改**:任一存储文件被改动,`restore` 会报出源路径与检查点 id 并拒绝写入
- **不防覆盖**:恢复会写入 `--dest-dir` 并覆盖同名文件,需要确定性时用空目录
- **覆盖层可选**:只有传 `--overlay-dir` 才会一起冻结
- **删除不可恢复**

## 环境变量

| 变量                  | 默认                  | 作用           |
| --------------------- | --------------------- | -------------- |
| `XTNA_CHECKPOINT_DIR` | `~/.xtna/checkpoints` | 检查点目录位置 |

## 限制

- 进程/容器只做观察记录,restore 不会重启或重新挂接
- `branch` 会复制父检查点的文件并记录 `parent_id` 与 `branch`;`diff` 可比较任意两个检查点
- 大证据包整体复制,磁盘占用随检查点数量增长
