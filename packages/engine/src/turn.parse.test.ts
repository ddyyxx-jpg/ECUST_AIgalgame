import { describe, expect, it } from "vitest";
import { parseTurn } from "./turn.parse.ts";

const base = { narrative: "你走进图书馆，空气里全是纸味。", proposals: [] };

describe("parseTurn 容错提取", () => {
  it("去掉 ```json 围栏", () => {
    expect(parseTurn("```json\n" + JSON.stringify(base) + "\n```")).toEqual(base);
  });

  it("叙事字符串里含 ``` 的合法 JSON 不被围栏逻辑截断（PR #23 复审回归）", () => {
    const payload = JSON.stringify({ narrative: "试试这个 ```js\nconsole.log(1)\n``` 行不行", proposals: [] });
    expect(parseTurn(payload)).toEqual({ narrative: "试试这个 ```js\nconsole.log(1)\n``` 行不行", proposals: [] });
  });

  it("忽略前后说明文字", () => {
    expect(parseTurn("好的，结果如下：" + JSON.stringify(base) + " 希望有帮助")).toEqual(base);
  });

  it("只取第一个平衡对象，不把后面的 } 当结构", () => {
    // 旧实现取 lastIndexOf("}") 会把"最后一行是 }"也切进来 → JSON.parse 失败
    expect(parseTurn(JSON.stringify(base) + " 备注：最后一行是 } 不是结构")).toEqual(base);
  });

  it("容忍尾随逗号，且字符串里的 ,} 不受影响", () => {
    expect(parseTurn('{"narrative":"a,} b","proposals":[],}')).toEqual({ narrative: "a,} b", proposals: [] });
  });

  it("字符串内部的 } 与转义引号不破坏配对", () => {
    const payload = JSON.stringify({ narrative: '他说："}"', proposals: [] });
    expect(parseTurn(payload + " 结束}")).toEqual({ narrative: '他说："}"', proposals: [] });
  });

  it("截断的 JSON 返回 null（交给自动修复，不在本地瞎补）", () => {
    expect(parseTurn('{"narrative":"说到一半，然后')).toBeNull();
  });

  it("非 JSON 文本返回 null", () => {
    expect(parseTurn("抱歉，我不能输出 JSON。")).toBeNull();
  });
});
