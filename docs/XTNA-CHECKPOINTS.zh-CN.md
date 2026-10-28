# 调查检查点

`npm run checkpoint -- <命令>` 把一次调查依赖的文件——Evidence 包与符号覆盖层——冻结进一个
带哈希清单的内容寻址目录。

恢复时**先校验每个文件的哈希再写入**,所以检查点不可能悄悄还原出不同的字节。

它快照的是你指定的文件,不是运行中的进程、容器或目标内存。

## 命令

```bash
npm run checkpoint -- create --name "session-12" --evidence .verify/evidence.json --overlay-dir ~/.xtna/overlays
npm run checkpoint -- list
npm run checkpoint -- restore --id cp_xxx --dest-dir ./restored --overlay-dir ./restored/overlays
npm run checkpoint -- show --id cp_xxx
npm run checkpoint -- delete --id cp_xxx
```

## 行为要点

- **防篡改**:任一存储文件被改动,`restore` 会报出源路径与检查点 id 并拒绝写入
- **不防覆盖**:恢复会写入 `--dest-dir` 并覆盖同名文件,需要确定性时用空目录
- **覆盖层可选**:只有传 `--overlay-dir` 才会一起冻结
- **删除不可恢复**

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `XTNA_CHECKPOINT_DIR` | `~/.xtna/checkpoints` | 检查点目录位置 |

## 限制

- 不做进程/容器状态快照,只到文件层
- 暂无分支与 diff,每个检查点是独立快照
- 大证据包整体复制,磁盘占用随检查点数量增长