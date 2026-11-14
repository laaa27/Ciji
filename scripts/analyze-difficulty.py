"""
真题 vs 生成文：句法难度对比（纯规则判定，零依赖）。

配套 `gen-article.mjs` 使用：改提示词前先跑这里拿到基线，改完再跑一次比 delta。
判定规则全部显式写在这里，避免"黑箱打分"：
  句子切分  —— 按 [.!?] + 后接空白/引号切；引号内的话照常算独立句
  词数      —— [A-Za-z][A-Za-z'-]*
  从句      —— 命中三类标记各算一条子句：
               ① 关系词 which/who/whom/whose/where/when（不在句首）
               ② 从属连词 that/although/though/because/since/if/unless/while/
                  whereas/whether/before/after/until/once/as/provided/than/so that…
               ③ 逗号后的非谓语短语（, -ing / , -ed / , to do）
  简单句    —— 无上述三类标记，且无 and/but/or 连接的第二个谓语
  嵌套      —— 同句命中 ≥2 条标记算两层，≥3 条算三层以上
  特殊句式  —— 正则命中（非限制性定从 / 强调句 / 倒装 / 虚拟 / 破折号插入语 /
              独立主格 / 被动 / there be / 同位语 / 冒号列举）

用法（在仓库根目录执行）：
  python scripts/analyze-difficulty.py gen scripts/out/<生成结果>.json [更多.json ...]
"""
import json
import re
import sys
from pathlib import Path
from statistics import pstdev

HERE = Path(__file__).parent
CORPUS = HERE / "corpus"

WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z])")

REL = re.compile(r"(?<!^)\b(which|who|whom|whose|where|when)\b", re.I)
SUB = re.compile(
    r"\b(that|although|though|because|since|if|unless|while|whereas|whether|"
    r"before|after|until|once|provided|than|so that|such that|even though|"
    r"in order that|as if|as though)\b",
    re.I,
)
NFIN = re.compile(r",\s+(having\s+)?[a-z]+(ing|ed)\b|,\s+to\s+[a-z]+\b", re.I)
COORD_VERB = re.compile(
    r",?\s+(and|but|or|yet|so)\s+[A-Za-z]+\s+"
    r"(is|are|was|were|has|have|had|will|would|can|could|may|might|must|do|does|did|"
    r"[a-z]+ed|[a-z]+s)\b"
)

SPECIAL = {
    "非限制性定从": re.compile(r",\s+(which|who|whom|whose)\b", re.I),
    "强调句": re.compile(r"\b[Ii]t (is|was)\b[^.]{0,60}?\bthat\b"),
    "倒装": re.compile(
        r"^(Only|Never|Not until|Hardly|Little|Rarely|Seldom)\b"
        r"|\b(never|rarely|seldom)\s+(have|has|had|do|does|did|can|could|will|would)\b",
        re.I,
    ),
    "虚拟语气": re.compile(r"\bif\b[^.]{0,80}\b(were|had)\b|\bwould have\b|\bwere to\b|\bhad\b[^.]{0,40}\bwould\b", re.I),
    "破折号插入": re.compile(r"—[^—]{2,80}—|—"),
    "独立主格": re.compile(r"\b(with\s+)?(its|their|his|her|the|a|an)\s+[a-z]+\s+[a-z]+(ing|ed)\b,", re.I),
    "there be": re.compile(r"\bthere (is|are|was|were|has been|have been)\b", re.I),
    "同位语/插入语": re.compile(r",\s+(a|an|the)\s+[a-z]+(?:[ -][a-z]+){0,3}\s*,", re.I),
    "冒号分号列举": re.compile(r"[:;]"),
}
PASSIVE = re.compile(r"\b(is|are|was|were|be|been|being)\s+([a-z]+ed|[a-z]+en)\b", re.I)
# 短语对偶框架：与 src/domain/article.ts 的 CONTRAST_PHRASE / CONTRAST_ANTITHESIS 同口径。
# 每处单看都通顺，连起来读就是「作者只有一招」——实测 rather than 篇均 2.1 次（六级），真题 0.33。
CONTRAST = re.compile(r"\b(rather than|instead of|unlike)\b|\bnot\b[^.;]{0,60}\bbut\b", re.I)

PREPS = set(
    "in on at for with by from of to into onto about against among between through "
    "during despite over under within without across along around behind beyond "
    "toward towards upon via per than as".split()
)
NOMINAL = re.compile(r"(tion|sion|ment|ance|ence|ity|ness|ism|ship)$", re.I)
ADJ_SUFFIX = re.compile(r"(ous|ive|able|ible|al|ic|ful|less|ary|ent|ant)$", re.I)
PARTICIPLE = re.compile(r"\b[a-z]+(ing|ed)\b", re.I)


def split_sents(text):
    flat = re.sub(r"\s+", " ", text).strip()
    return [s for s in SENT_SPLIT.split(flat) if s.strip()]


def clause_marks(s):
    n = 0
    n += len(REL.findall(s))
    n += len(SUB.findall(s))
    n += len(NFIN.findall(s))
    return n


def is_simple(s):
    if clause_marks(s) > 0:
        return False
    if COORD_VERB.search(s):
        return False
    return True


def analyse(text):
    sents = split_sents(text)
    lens = [len(WORD_RE.findall(s)) for s in sents]
    n_s, n_w = len(sents), sum(lens)

    buckets = {"≤12": 0, "13-20": 0, "21-30": 0, "31-40": 0, ">40": 0}
    for L in lens:
        if L <= 12:
            buckets["≤12"] += 1
        elif L <= 20:
            buckets["13-20"] += 1
        elif L <= 30:
            buckets["21-30"] += 1
        elif L <= 40:
            buckets["31-40"] += 1
        else:
            buckets[">40"] += 1

    marks = [clause_marks(s) for s in sents]
    simple = sum(1 for s in sents if is_simple(s))
    special = {k: sum(1 for s in sents if rx.search(s)) for k, rx in SPECIAL.items()}
    special["被动语态"] = sum(1 for s in sents if PASSIVE.search(s))
    any_special = sum(
        1
        for s in sents
        if any(rx.search(s) for rx in SPECIAL.values()) or PASSIVE.search(s)
    )

    tokens = [w.lower() for w in WORD_RE.findall(text)]
    preps = sum(1 for w in tokens if w in PREPS)
    nominal = sum(1 for w in tokens if NOMINAL.search(w) and len(w) > 5)
    adjs = sum(1 for w in tokens if ADJ_SUFFIX.search(w) and len(w) > 4)
    parts = sum(1 for w in tokens if PARTICIPLE.search(w) and len(w) > 5)

    return {
        "词数": n_w,
        "句数": n_s,
        "平均句长": round(n_w / n_s, 1),
        "中位句长": sorted(lens)[n_s // 2],
        "句长标准差": round(pstdev(lens), 1),
        "p90句长": sorted(lens)[int(n_s * 0.9)],
        "最长句": max(lens),
        **{f"句长{b}": round(100 * v / n_s) for b, v in buckets.items()},
        "简单句%": round(100 * simple / n_s),
        "对偶框架数": len(CONTRAST.findall(text)),
        "从句标记/句": round(sum(marks) / n_s, 2),
        "≥2层嵌套句%": round(100 * sum(1 for m in marks if m >= 2) / n_s),
        "≥3层嵌套句%": round(100 * sum(1 for m in marks if m >= 3) / n_s),
        "零从句句%": round(100 * sum(1 for m in marks if m == 0) / n_s),
        **{f"{k}%": round(100 * v / n_s) for k, v in special.items()},
        "任一特殊句式%": round(100 * any_special / n_s),
        "介词/百词": round(100 * preps / n_w, 1),
        "名词化/百词": round(100 * nominal / n_w, 1),
        "形容词性词/百词": round(100 * adjs / n_w, 1),
        "分词形/百词": round(100 * parts / n_w, 1),
        "平均词长": round(sum(len(t) for t in tokens) / n_w, 2),
    }


def load_corpus(level):
    raw = (CORPUS / f"{level}.txt").read_text(encoding="utf-8")
    return [p.strip() for p in re.split(r"\n---\n", raw) if p.strip()]


def mean_rows(rows):
    keys = list(rows[0].keys())
    return {k: round(sum(r[k] for r in rows) / len(rows), 1) for k in keys}


GROUPS = [
    ("① 长短句分布（占句子数 %）", ["平均句长", "中位句长", "p90句长", "最长句", "句长标准差",
                                    "句长≤12", "句长13-20", "句长21-30", "句长31-40", "句长>40"]),
    ("② 简单句与从句密度", ["简单句%", "零从句句%", "从句标记/句", "≥2层嵌套句%", "≥3层嵌套句%", "对偶框架数"]),
    ("③ 特殊句式（含该句式的句子占比 %）",
     ["非限制性定从%", "强调句%", "倒装%", "虚拟语气%", "破折号插入%", "独立主格%",
      "there be%", "同位语/插入语%", "冒号分号列举%", "被动语态%", "任一特殊句式%"]),
    ("④ 修饰成分复杂化（每百词）", ["介词/百词", "名词化/百词", "形容词性词/百词", "分词形/百词", "平均词长"]),
]


def show(title, keys, c, g):
    print(f"\n{title}")
    print("   " + "指标".ljust(18) + "真题".rjust(8) + "生成".rjust(8) + "差".rjust(8))
    for k in keys:
        cv, gv = c.get(k), g.get(k)
        diff = "" if cv is None or gv is None else f"{gv - cv:+.1f}"
        print(f"   {k.ljust(18)}{str(cv).rjust(8)}{str(gv).rjust(8)}{diff.rjust(8)}")


def main():
    files = sys.argv[2:]
    per_level = {}
    for f in files:
        data = json.loads(Path(f).read_text(encoding="utf-8"))
        for res in data["results"]:
            for r in res["runs"]:
                per_level.setdefault(res["level"], []).append(" ".join(r["sentences"]))

    for lv in ("cet4", "cet6", "kaoyan"):
        if lv not in per_level:
            continue
        c_rows = [analyse(t) for t in load_corpus(lv)]
        g_rows = [analyse(t) for t in per_level[lv]]
        c_m, g_m = mean_rows(c_rows), mean_rows(g_rows)
        print(f"\n══════ {lv}｜真题 {len(c_rows)} 篇 vs 生成 {len(g_rows)} 篇（各指标取均值）")
        for title, keys in GROUPS:
            show(title, keys, c_m, g_m)


if __name__ == "__main__":
    main()
