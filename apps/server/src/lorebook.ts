/**
 * SillyTavern 风格的 World Info / Lorebook（内容层，不改 op/契约）：
 * 关键词命中才把条目注入叙事提示词；constant 条目每回合都带；作者注是稳定前缀。
 *
 * 为什么放内容层：世界观细节会随世界线频繁增删，写进代码就得每次发版；这里只做
 * "读 JSON → 关键词匹配 → 排序截断"，不产生任何状态变更，也不让 LLM 直接写库。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const EntrySchema = z.object({
  id: z.string().min(1).max(80),
  keys: z.array(z.string().min(1).max(80)).min(1).max(20),
  content: z.string().min(1).max(600),
  order: z.number().int().min(-1000).max(1000).default(0),
  constant: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const BookSchema = z.object({
  schemaVersion: z.literal(1),
  authorNote: z.string().max(800).optional(),
  entries: z.array(EntrySchema).max(200).default([]),
});

export type LoreEntry = z.infer<typeof EntrySchema>;
export interface Lorebook {
  authorNote?: string;
  entries: LoreEntry[];
}

/** 缺文件 = 没有 lorebook（不影响启动）；坏 JSON 打 warning 后同样降级。 */
export async function loadLorebook(contentDir: string): Promise<Lorebook | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(contentDir, "lorebook.json"), "utf8"));
    const parsed = BookSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[lorebook] content/lorebook.json 校验失败，已忽略：${parsed.error.message}`);
      return undefined;
    }
    return parsed.data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[lorebook] content/lorebook.json 读取失败，已忽略：${e instanceof Error ? e.message : String(e)}`);
    }
    return undefined;
  }
}

/**
 * 按关键词选条目：constant 必带；其余大小写不敏感子串匹配。order 降序、id 升序保证
 * 同输入逐字节稳定（KV 缓存前缀不能抖）。
 */
export function selectWorldInfo(book: Lorebook, contextText: string, limit = 6): string[] {
  const text = contextText.toLowerCase();
  const hits = book.entries
    .filter((entry) => entry.enabled)
    .filter((entry) => entry.constant || entry.keys.some((key) => text.includes(key.toLowerCase())))
    .sort((a, b) => b.order - a.order || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
  return hits.map((entry) => entry.content);
}
