/**
 * introduce —— 自我介绍（"我叫林然 / 叫我小林"）。
 *
 * 为什么需要它：NPC 的"认识"是一级判定（知道名字才算认识，见 docs/06 §7）。
 * 玩家说出名字后，这里做两件事：
 *   1. 把在场每个 NPC 的 `knows_name` 置 true（attr.set，经 Arbiter 校验）；
 *   2. 给每个 NPC 写一条记忆（名字 + 第一次说话），后续回合靠记忆召回，
 *      所以"下次见面他记得你叫什么"不需要任何引擎改动。
 *
 * 只提议、不写库；不持有 LLM；不读环境变量。
 */
import type { Entity, Module, ModuleContext, ModuleOutcome, Proposal } from "../../../packages/shared/src/contract/types.ts";

/** 认识的属性键（content/registry/attrs.json 声明，npc 作用域） */
const KNOWS_NAME_ATTR = "knows_name";

/** 「我是X」里的 X 可能是身份而不是名字，这些词一律不当作姓名 */
const NOT_A_NAME = new Set([
  "学生",
  "新生",
  "同学",
  "转学生",
  "大一",
  "大二",
  "大三",
  "大四",
  "研究生",
  "老师",
  "同学来的",
  "一个人",
  "路过的",
  "这里的",
  "新来的",
  "谁",
  "什么",
  "你",
  "他",
  "她",
]);

/** 名字后面的口语尾巴（"叫我小林就行"）、疑问词开头（"我叫什么来着"）都不算名字 */
function cleanName(raw: string): string | undefined {
  const name = raw.replace(/(就行|就好|也可以|吧|啊|呀|哦|了)+$/u, "");
  if (name.length < 2) return undefined;
  if (/^(什么|啥|哪|谁|怎么|多少|如何)/u.test(name)) return undefined;
  if (/(来着|呢|吗)$/u.test(name)) return undefined;
  return NOT_A_NAME.has(name) ? undefined : name;
}

/**
 * 从自然语言里抽姓名：优先「我叫/名字叫/名字是/叫我」，其次「我是X」（X 不在身份词表里才认）。
 * 姓名限制 2~6 个汉字或英文/数字，避免把整句当成名字。
 */
export function extractName(input: string): string | undefined {
  const text = input.trim();
  const strict =
    /(?:我叫|我的名字叫|我的名字是|名字叫|名字是|叫我)\s*([A-Za-z0-9\u4e00-\u9fa5]{2,6})/.exec(text) ??
    /(?:我叫|我的名字叫|我的名字是|名字叫|名字是|叫我)\s*([A-Za-z0-9\u4e00-\u9fa5]{2,6})/.exec(text);
  if (strict) return cleanName(strict[1] ?? "");
  const loose = /我(?:是|叫)\s*([A-Za-z0-9\u4e00-\u9fa5]{2,6})/.exec(text);
  if (loose) return cleanName(loose[1] ?? "");
  return undefined;
}

/** 在场且活着的 NPC（提案对象） */
function presentNpcs(ctx: ModuleContext): Entity[] {
  return ctx.state.room.scene.presentIds
    .map((id) => ctx.query.entity(id))
    .filter((e): e is Entity => e !== undefined && e.kind === "npc" && e.status === "active");
}

/** 问对方名字的几种说法：对方一开口回答，玩家就该"知道"了（名字解锁） */
const ASK_NAME_RE = /(你叫什么|你叫啥|你叫什么呢|你叫什么名字|怎么称呼你|你的名字|贵姓|你是哪位|你哪位|你叫名字)/u;

const introduceModule: Module = {
  intent(ctx): ModuleOutcome {
    const name = extractName(ctx.input);
    const asked = ASK_NAME_RE.test(ctx.input);
    if (!name && !asked) {
      // 既没自述也没问名字：不认领，交给模型正常叙事
      return { ok: false, proposals: [], error: { code: "E_TOOL_UNKNOWN", message: "没有识别到姓名" } };
    }
    const npcs = presentNpcs(ctx);
    const proposals: Proposal[] = [];
    if (name) {
      // 自述姓名：只让在场 NPC 记住"你叫什么"。
      // 注意：这**不等于**玩家知道对方的名字（knows_name 由对方自报姓名时才解锁，
      // 见 apps/server/src/name-unlock.ts），所以这里不写 knows_name。
      for (const npc of npcs) {
        proposals.push({
          op: "memory.write",
          args: {
            ownerId: npc.id,
            content: `这位同学自我介绍叫${name}，是第一次说话。`,
            tags: ["自我介绍", "名字"],
            salience: 4,
            visibility: "private",
            about: [ctx.actorId],
          },
          reason: "记住对方的称呼与第一次见面的场景",
        });
      }
      const who = npcs.length > 0 ? "在场的人" : "周围没有人";
      const facts = npcs.length > 0 ? [`你做了自我介绍：我叫${name}（${who}记住了这个称呼）`] : [];
      return { ok: true, proposals, facts };
    }
    // 问名字：只写"谁问过我的名字"的记忆。这里**不产出 facts**——是否真的问到名字
    // 由服务端按解锁结果决定（审阅 P2-9：模型没报名时也宣称"你问到了对方的名字"是假信息）。
    // 真名解锁见 apps/server/src/name-unlock.ts。
    for (const npc of npcs) {
      proposals.push({
        op: "memory.write",
        args: {
          ownerId: npc.id,
          content: "这位同学问了我的名字，我把称呼告诉了他/她。",
          tags: ["自我介绍", "名字"],
          salience: 3,
          visibility: "private",
          about: [ctx.actorId],
        },
        reason: "记住谁问过我的名字（第一次交谈）",
      });
    }
    return { ok: true, proposals };
  },
};

export default introduceModule;
