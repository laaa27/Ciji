#!/usr/bin/env python3
"""把 cet-practice 的题库导出成词迹训练栏目用的 JSON。

题库来源是别人整理好的 SQLite（本地 file，不进仓库）。这里只做三件事：
读出套卷 → 把解析文本切成结构化的几节 → 按「套卷一文件」写到 public/training/。

用法：
    python scripts/import-training.py --db <cet6.db> [--from 2024] [--levels cet6,cet4,kaoyan]

产物：
    public/training/index.json      套卷索引（列表页只读这个）
    public/training/p/<key>.json    单套全文

为什么按套分文件：全量一百多套塞一个 JSON，热启动要解析几 MB，
列表页却只需要几十字节一条的索引。与 data/article.ts 的「全文 + 索引」同构。
"""

import argparse
import json
import os
import re
import sqlite3
import sys

# 题型展示名。顺序即页面里的顺序
SECTION_LABEL = {
    'cloze': '完形填空',
    'matching': '长篇阅读',
    'reading1': '阅读理解',
    'reading2': '阅读理解',
    'writing': '写作',
    'translation': '翻译',
}
# 写作是主观题：判分只能靠范文对照，做题闭环价值低，不做。
# 听力也没有导入：没有音频做不了「听→答」的闭环，2026-11-16 按用户要求整个去掉。
# 翻译只给考研加：四六级的翻译是「汉译英」，考研是「英译汉 5 句（英语二整段）」，
# 后者能当阅读材料对照参考译文用，前者只能靠和人比对，闭环更弱。
SECTION_ORDER = ['cloze', 'matching', 'reading1', 'reading2']
EXTRA_SECTIONS = {'kaoyan': ['translation']}

# 考研新题型（matching）变体 → 展示名。判定规则见 matching_variant()
MATCHING_LABELS = {
    'matching': '信息匹配',
    'ordering': '排序题',
    'headings': '小标题',
    'gapfill': '七选五',
    'opinions': '观点概括',
    'tf': '判断题',
}

# 人名-空位两种排版：观点概括的题干要从段文本里提取人名（2024 英语二是名字在后）
NAME_BEFORE_RE = re.compile(r'^\s*([^:：\n]{2,40}?):\s*__\(\d+\)__')
NAME_AFTER_RE = re.compile(r'^\s*__\(\d+\)__\s*([^:：\n]{1,40})$')
# 名字行不含句读 —— 七选五的段也可能以空位开头，靠这条把两种排版区分开
NAME_PUNCT_RE = re.compile(r'[.!?。！？；;，,]')

# 句末标点后接空格，才算一个句子边界。缩写单独排掉，否则 Mr. Smith 会被切开
ABBREV = {'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'no', 'fig', 'al'}


def split_sentences(text):
    """把一段英文切成句子。题库原文没有段落信息，只能靠标点切。"""
    text = (text or '').strip()
    if not text:
        return []

    out = []
    start = 0
    for m in re.finditer(r'[.!?]["\')\]]?\s+', text):
        head = text[start:m.start() + 1]
        tail_word = re.search(r'([A-Za-z.]+)\.$', head)
        if tail_word and tail_word.group(1).lower().rstrip('.') in ABBREV:
            continue
        nxt = text[m.end():m.end() + 1]
        # 下一句应当以大写字母、引号或数字开头；否则多半是小数点或省略号
        if nxt and not (nxt.isupper() or nxt in '"\u201c\u2018(' or nxt.isdigit()):
            continue
        piece = text[start:m.end()].strip()
        if piece:
            out.append(piece)
        start = m.end()

    rest = text[start:].strip()
    if rest:
        out.append(rest)
    return out


def parse_analysis(text):
    """解析文本按【答案】【判型】【拆句】【定位】【选项】分节，切出来即可。

    没有分节标记的老数据（少量）整段留在 raw 里，界面照样能显示。
    """
    if not text:
        return None

    blocks = {}
    cur = None
    for line in text.split('\n'):
        m = re.match(r'^【(.+?)】\s*(.*)$', line)
        if m:
            cur = m.group(1)
            blocks[cur] = [m.group(2)]
        elif cur:
            blocks[cur].append(line)

    if not blocks:
        return {'raw': text.strip()}

    out = {}

    ans = ' '.join(blocks.get('答案', [])).strip()
    if ans:
        m = re.match(r'^([A-Z]+)\s*(?:[（(](.+?)[）)])?', ans)
        if m:
            out['answer'] = m.group(1)
            if m.group(2):
                out['qtype'] = m.group(2)
        else:
            out['answer'] = ans[:40]

    for src, dst in (('判型', 'judge'), ('拆句', 'split'), ('定位', 'locate')):
        v = '\n'.join(blocks.get(src, [])).strip()
        if v:
            out[dst] = v

    # 七选五（【正确句】【缺口】【线索】）与小标题（【小标题】【主旨】【依据】）的
    # 解析节名都映射到 correct / gap / clue 三个字段，前端按变体换标签
    for src, dst in (
        ('正确句', 'correct'),
        ('缺口', 'gap'),
        ('线索', 'clue'),
        ('小标题', 'correct'),
        ('主旨', 'gap'),
        ('依据', 'clue'),
    ):
        v = '\n'.join(blocks.get(src, [])).strip()
        if v:
            out[dst] = v

    opts = parse_options(blocks.get('选项'))
    if opts:
        out['options'] = opts

    rest = '\n'.join(blocks.get('解析', [])).strip()
    if rest:
        out['note'] = rest
    if not out:
        # 非标准分节（排序题的「正确段 B 【承接前一段】…」等）：整段挂 raw，
        # 原样可读比丢掉强
        return {'raw': text.strip()}
    return out


def parse_options(lines):
    """【选项】每项形如「A)」+ 判定词 + 理由，切成分项。"""
    if not lines:
        return []

    text = '\n'.join(lines)
    marks = list(re.finditer(r'(?m)^\s*([A-F])\s*[)）]\s*$', text))
    if not marks:
        # 有的排版是「A) 与原文相反」写在一行
        marks = list(re.finditer(r'(?m)^\s*([A-F])\s*[)）]\s*', text))
    if not marks:
        return []

    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end].strip()
        lines_ = [x.strip() for x in body.split('\n') if x.strip()]
        if not lines_:
            continue
        verdict = lines_[0]
        note = ' '.join(lines_[1:])
        out.append({'key': m.group(1), 'verdict': verdict, 'note': note})
    return out


def _is_zh_line(line):
    """这一行是不是中文译文。

    为什么不再用「这行有几个汉字」：四六级的英文正文里常带中文括注
    （`(英国国家医疗服务体系)`、`(与腹泻相关)`、`(在道德层面上)`），一行英文能有十来个汉字；
    按数量判会把英文行当成译文开头，那一行**之后的所有行**都被并进译文，
    正文就此断在半句上 —— 真机看到的就是「这篇文章少了一截」。

    改用「汉字占字母+汉字的比例」：带括注的英文行通常不到两成，真正的译文行基本都是汉字。
    """
    han = len(re.findall(r'[\u4e00-\u9fa5]', line))
    if han == 0:
        return False
    letters = len(re.findall(r'[A-Za-z]', line))
    # 纯汉字的短行（「作用。」这种硬换行残片）也算中文：按 3 字起步会把译文的最后一行
    # 判成英文，整段的译文边界就崩了。混着字母的短行不判（比如「务体系).」）。
    if han < 3 and letters > 0:
        return False
    # 译文里经常夹着英文术语（「Jesse Jackson宣布"African American"是…」），汉字占比会被压到
    # 三成左右；但这类行一定带中文标点，英文正文里不会有。
    if han >= 6 and len(re.findall(r'[\uff0c\u3002\u3001\uff1b\uff1a\uff1f\uff01\u201c\u201d]', line)) >= 2:
        return True
    return han / (han + letters) >= 0.3


def _find_zh_run(text):
    """正文里第一处「成段中文」的起点（括号里的中文括注不算）。

    兜底用：即便分界判错，正文里也不该出现整段中文——真出现了就从那里切断，并到译文开头。
    """
    # 原文英文正文里除了括号括注，一个汉字都没有（全库核对过），所以括号外出现两个连续汉字
    # 就一定是译文漏进来了。
    for mk in re.finditer(r'[\u4e00-\u9fa5]{2,}', text):
        before = text[:mk.start()].rstrip()[-1:]
        after = text[mk.end():].lstrip()[:1]
        if before in '(\uff08' or after in ')\uff09':
            continue
        return mk.start()
    return None


# 一行的结尾是不是「句子结束」。用来判断英文那侧有没被硬换行切断。
_ENDS_SENTENCE = re.compile(r'[.!?\u3002\uff1f\uff01]["\u201d\u2019)\uff09]$|["\u201d\u2019)\uff09]$')


# 解析页夹在段落之间的排版杂质：题号说明、部件标题、「Passage One」小标题。
# 它们常常落在某段译文**后面**，会把「译文在块尾」这个前提破坏掉（译文会被当成英文），
# 所以要在切分之前先逐行剔掉。
_NOISE_LINE = re.compile(
    r'^(?:Questions?\s+\d+\s+to\s+\d+\s+are\s+based\s+on\s+the\s+following\s+passage\.?'
    r'|Part\s+[IVX]+(?:\s+Section\s+[A-C])?(?:\s*\(\d+\))?'
    r'|Passage\s+(?:One|Two|Three|Four))$',
    re.I,
)


def parse_passage_translation(text):
    """解析页里的「P1..Pn 段号、逐段附中文翻译」块 → [(英文, 中文)]。

    排版是「P1 + 英文段 + 中文段 + P2 + …」，中文段紧随英文段。
    末尾还会接「题目与逐题解析」，遇到就停。
    """
    if not text:
        return []

    # 砍掉末尾的题目解析部分
    tail = text.find('题目与逐题解析')
    if tail > 0:
        text = text[:tail]

    marks = list(re.finditer(r'(?m)^\s*P(\d+)\s*$', text))
    if not marks:
        # 有的排版 P1 与正文同一行。数字后面不能紧跟破折号/字母：前言里的 "P1–P9 段号…"
        # 那种写法不是段号，匹配进来会让整段前言变成一个段落
        marks = list(re.finditer(r'(?m)^\s*P(\d+)(?![0-9A-Za-z\u2013\u2014-])\s*', text))
    if len(marks) < 2:
        return []

    # 正文前面常有一段「P1–P9 段号、逐段附中文翻译…」+ Part/Directions + Passage One 的前言，
    # 里面也散落着 "P9" 这种像段号的字样。真正的段落从 P1 开始，把它之前的标记全丢掉，
    # 否则那段前言会变成一个「中文正文」段落塞进文章里。
    for idx, mk in enumerate(marks):
        if int(mk.group(1)) == 1:
            marks = marks[idx:]
            break
    if len(marks) < 2:
        return []

    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end]

        # 英文在前、中文在后。**从块尾往前找连续的中文行**，而不是从块头找第一个「像中文」的行：
        # 译文本来就是块尾的一段，从后往前扫时，中途那句带中文括注的英文行拉不动边界。
        lines = [ln.strip() for ln in body.split('\n') if ln.strip()]
        lines = [ln for ln in lines if not _NOISE_LINE.match(ln)]
        first_zh = len(lines)
        while first_zh > 0 and _is_zh_line(lines[first_zh - 1]):
            first_zh -= 1
        if first_zh == len(lines):
            first_zh = None
        # 只有一行、又只有两三个汉字的「译文」多半是正文尾巴被误判，不认它
        if first_zh is not None:
            tail_zh = sum(len(re.findall(r'[\u4e00-\u9fa5]', l)) for l in lines[first_zh:])
            if len(lines) - first_zh < 2 and tail_zh < 6:
                first_zh = None

        en_lines = lines[:first_zh] if first_zh is not None else lines
        zh_lines = lines[first_zh:] if first_zh is not None else []

        # 中文括注被硬换行切开时（`…Service(英国国家医疗服` / `务体系).`），续行是几个纯汉字
        # 加一个右括号，会被判成译文，英文就断在半句上。只把这种「没有中文标点、以右括号收尾」
        # 的残片搬回英文——真正的译文行都带中文标点，不会被误搬。
        while (
            zh_lines
            and re.search(r'\)\.?$', zh_lines[0])
            and not re.search(r'[\uff0c\u3002\u3001\uff1b\uff1a\uff1f\uff01]', zh_lines[0])
        ):
            en_lines.append(zh_lines.pop(0))

        en = ' '.join(en_lines)
        # 解析页会混进一句题号说明，去掉
        en = re.sub(r'Questions?\s+\d+\s+to\s+\d+\s+are\s+based\s+on\s+the\s+following\s+passage\.?',
                    '', en, flags=re.I)
        en = re.sub(r'\s+', ' ', en)
        # 硬换行落在中文括注中间时会插进一个空格（「医疗服 务体系」），抹掉
        en = re.sub(r'(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])', '', en).strip()

        # 译文同理：硬换行会把英文术语拆开，但直接把空白全删又会变成 NationalHealthService；
        # 只粘掉中文之间的空格，拉丁词之间保留
        zh = ' '.join(zh_lines)
        zh = re.sub(r'(?<=[^\x00-\x7f])\s+(?=[\u4e00-\u9fa5])', '', zh)
        zh = re.sub(r'(?<=[\u4e00-\u9fa5])\s+(?=[^\x00-\x7f])', '', zh)
        zh = re.sub(r'(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])', '', zh)
        zh = re.sub(r'\s+', ' ', zh).strip()

        # 兜底：正文里不该出现成段中文。出现了说明那块其实是译文，从那里切断并到译文开头，
        # 免得「中英混排的一段话」出现在正文里。
        cut = _find_zh_run(en)
        if cut is not None:
            tail = en[cut:].strip()
            en = en[:cut].strip()
            zh = (tail + zh).strip()

        # P1– 这种标号残片会被当成一段，扔掉：少于 3 个词或没有成词的基本都是噪声
        if len(re.findall(r"[A-Za-z]{2,}", en)) < 3:
            continue
        if en:
            out.append((en, zh))
    return out


def material_passages(row, section):
    """把一条 section_materials 变成「逐段」结构：每段若干句 + 可选的中译。

    阅读的中译来自 translation_json 里的 P1..Pn 块（解析页原文就是这么排的），
    段落边界也用它的 —— 题库的 passage 是一整段字符串，本身没有段落信息。

    同时返回 brief：写作/翻译的题目要求，不掺进正文（正文要能逐词点查）。
    """
    try:
        data = json.loads(row['content_json'] or '{}')
    except json.JSONDecodeError:
        return [], ''
    brief = (data.get('prompt') or '').strip()

    # 信息匹配：段落带 A/B/C… 标号，一段一段给
    if isinstance(data.get('paragraphs'), list):
        paras = []
        for p in data['paragraphs']:
            txt = (p.get('text') or '').strip()
            if not txt:
                continue
            sents = [{'en': s} for s in split_sentences(txt)]
            if sents:
                label = (p.get('label') or '').strip()
                if label:
                    sents[0]['label'] = label
                paras.append({'sents': sents})
        return paras, brief

    # 翻译：正文是 source_paragraphs 里的英文原文（逐段），题目要求进 brief。
    # 不能落到下面那个 body 兜底 —— 那里的 reference_translation 是中文，
    # 会把「翻译题」的正文导成中文（试导时正是这个坑）。
    # brief 用 materials.directions 而不是 content_json.prompt：后者把整篇原文又抄了一遍，
    # 页面上会出现「题目要求框里一篇文章 + 下面又是一篇」的重复。
    if section == 'translation':
        paras = []
        for en_p in (data.get('source_paragraphs') or []):
            en = (en_p.get('text') or '').strip() if isinstance(en_p, dict) else ''
            sents = [{'en': s} for s in split_sentences(en)]
            if sents:
                paras.append({'sents': sents})
        if paras:
            return paras, ((row['directions'] or '').strip() or brief)

    # 文章：优先用结构化的逐段中译定段落边界
    text = (data.get('passage') or '').strip()
    if text:
        try:
            tr_data = json.loads(row['translation_json'] or '{}')
        except (json.JSONDecodeError, AttributeError):
            tr_data = {}

        # 考研的形状：中文段、英文段各一个数组，段数 1:1（懒笔记 .lt-zh 段落译文）。
        # 四六级是 passage_translation 排版块，脚本不认这个形状会把考研静默导成无译 + 假分段。
        tr_paras = tr_data.get('paragraphs')
        src_paras = data.get('source_paragraphs')
        if (isinstance(tr_paras, list) and isinstance(src_paras, list)
                and len(tr_paras) == len(src_paras)):
            paras = []
            for en_p, zh in zip(src_paras, tr_paras):
                en = (en_p.get('text') or '').strip() if isinstance(en_p, dict) else ''
                zh = (zh or '').strip()
                sents = [{'en': s} for s in split_sentences(en)]
                if not sents:
                    continue
                para = {'sents': sents}
                if zh:
                    para['zh'] = zh
                paras.append(para)
            if paras:
                return paras, brief

        # 四六级：解析页「P1..Pn 段号、逐段附中文翻译」块
        tr = tr_data.get('passage_translation') or ''
        blocks = parse_passage_translation(tr)
        if blocks:
            paras = []
            for en, zh in blocks:
                sents = [{'en': s} for s in split_sentences(en)]
                if not sents:
                    continue
                para = {'sents': sents}
                if zh:
                    para['zh'] = zh
                paras.append(para)
            if paras:
                return paras, brief
        # 没有译段就退回「每 4 句一段」，至少排版不变
        sents = [{'en': s} for s in split_sentences(text)]
        return [{'sents': sents[i:i + 4]} for i in range(0, len(sents), 4)], brief

    # 兜底：写作类材料的正文（翻译已在上面单独处理：正文用 source_paragraphs 的英文原文）
    body = data.get('model_essay') or ''
    if body.strip():
        sents = [{'en': s} for s in split_sentences(body)]
        return [{'sents': sents[i:i + 4]} for i in range(0, len(sents), 4)], brief

    return [], brief


def build_question(row):
    q = {
        'no': row['q_no'] if row['q_no'] is not None else row['q_index'] + 1,
        'type': row['qtype'],
    }
    stem = (row['stem'] or '').strip()
    if stem:
        q['stem'] = stem

    try:
        opts = json.loads(row['options_json'] or '[]')
    except json.JSONDecodeError:
        opts = []
    opts = [{'key': o.get('key'), 'text': (o.get('text') or '').strip()} for o in opts if o.get('key')]
    if opts:
        q['options'] = opts

    if row['answer']:
        q['answer'] = row['answer'].strip()
    if row['answer_source']:
        q['source'] = row['answer_source'].strip()

    an = parse_analysis(row['analysis_text'])
    if an:
        q['analysis'] = an
    return q


def _is_person_name(s):
    """题干是不是纯人名：短、无句读、每个词首字母大写。

    用于区分「人名-观点匹配」（2024 英语二：题干就是人名）与普通信息匹配
    （题干是陈述句，如 'Andrew Lansley held that …'，句中有小写词）。
    """
    if not s or len(s) > 40:
        return False
    if NAME_PUNCT_RE.search(s):
        return False
    words = s.split()
    if not 1 <= len(words) <= 4:
        return False
    # 人名里的小写连接词（Marx and Engels / von Neumann）不算破绽
    small = {'and', 'of', 'the', 'de', 'von', 'van'}
    return all(w[:1].isupper() or w.lower() in small for w in words)


def matching_variant(mat, questions):
    """结构化判定考研新题型变体。返回 (kind, label)。

    判定顺序：T/F 选项 → 判断题；given_chain → 排序题；段落带空位 →
    小标题（Directions 提 headings）/ 观点概括（空位段是人名行）/ 七选五；
    无空位 → 信息匹配（含观点例证类：题干是陈述句，答案是段落字母）。
    """
    if not mat:
        return 'matching', MATCHING_LABELS['matching']
    try:
        cj = json.loads(mat['content_json'] or '{}')
    except json.JSONDecodeError:
        cj = {}
    paras = cj.get('paragraphs') or []
    blanked = [p for p in paras if '__(' in (p.get('text') or '')]

    first_opts = []
    if questions:
        try:
            first_opts = json.loads(questions[0]['options_json'] or '[]')
        except json.JSONDecodeError:
            first_opts = []
    if first_opts and first_opts[0].get('key') in ('T', 'F'):
        return 'tf', MATCHING_LABELS['tf']
    if cj.get('given_chain'):
        return 'ordering', MATCHING_LABELS['ordering']
    if blanked:
        if 'headings' in (mat['directions'] or ''):
            return 'headings', MATCHING_LABELS['headings']
        named = sum(
            1
            for p in blanked
            if _blank_name(paras, _blank_no(p.get('text') or '')) is not None
        )
        if named >= max(1, int(len(blanked) * 0.8)):
            return 'opinions', MATCHING_LABELS['opinions']
        return 'gapfill', MATCHING_LABELS['gapfill']
    # 无空位：题干全是人名 → 观点概括（人名-段落匹配）；否则信息匹配
    stems = [(q['stem'] or '').strip() for q in questions]
    if stems and all(_is_person_name(s) for s in stems):
        return 'opinions', MATCHING_LABELS['opinions']
    return 'matching', MATCHING_LABELS['matching']


def _blank_no(text):
    """段文本里第一个空位的题号，没有则 None。"""
    m = re.search(r'__\((\d+)\)__', text)
    return int(m.group(1)) if m else None


def _blank_name(paras, no):
    """从含 __(no)__ 的段落提取人名；两种排版（名在前 / 名在后）都认。

    名字行必须短且不含句读 —— 七选五的段也可能以空位开头，靠这条区分。
    """
    if no is None:
        return None
    marker = '__(%d)__' % no
    for p in paras:
        t = (p.get('text') or '').strip()
        if marker not in t:
            continue
        m = NAME_BEFORE_RE.match(t)
        if m:
            name = m.group(1).strip()
        else:
            m = NAME_AFTER_RE.match(t)
            if not m:
                return None
            name = m.group(1).strip()
        if name and len(name) <= 40 and not NAME_PUNCT_RE.search(name):
            return name
        return None
    return None


def load_zh_splits():
    """英语二里「一句英文译成好几句中文」的段落，标点切不出等长段数。

    `kaoyan2-zh-split.json` 是手工切好的清单：套卷 key → 段落序号 → 每句中文。
    句子数对不上就忽略那一段（宁可退回整段译文，也不能把译文扣到别的句子上）。
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kaoyan2-zh-split.json')
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


ZH_SPLITS = load_zh_splits()


def attach_translation_zh(item, mat, qs, paper_key=''):
    """给翻译篇补中文。两种卷面，取法不同：

    - **英语一**：5 个划线句，题库里每题都带参考答案 → 直接贴到对应的那句英文上（句级，最准）。
      对不上（题干被改写过）就跳过那一句，绝不猜。
    - **英语二**：一整段英译汉，题库只给了逐段参考译文 → 落到 para.zh。
      前端 alignParaZh 会尝试按句切开逐句显示，切不齐就整段显示 ——
      宁可退回原样，也不能把译文错位到别的句子上。切不齐的那几段在
      `kaoyan2-zh-split.json` 里手工补了逐句版本。
    """
    def norm(t):
        return re.sub(r'\s+', ' ', t or '').strip()

    # 手工切好的逐句译文优先（只认句子数对得上的）
    for idx_s, parts in (ZH_SPLITS.get(paper_key) or {}).items():
        idx = int(idx_s)
        if 0 <= idx < len(item['paras']) and isinstance(parts, list) \
                and len(parts) == len(item['paras'][idx]['sents']):
            for s, zh in zip(item['paras'][idx]['sents'], parts):
                s['zh'] = zh
        else:
            print('  ! %s 第 %s 段的手工切句对不上，已忽略' % (paper_key, idx_s))

    sents = [s for p in item['paras'] for s in p['sents']]
    answers = [(norm(q['stem']), norm(q['answer'])) for q in qs
               if norm(q['stem']) and norm(q['answer'])]
    if answers:
        hit = 0
        for stem, ans in answers:
            for s in sents:
                en = norm(s['en'])
                if en == stem or stem in en or en in stem:
                    s['zh'] = ans
                    hit += 1
                    break
        return hit

    try:
        data = json.loads(mat['content_json'] or '{}')
    except json.JSONDecodeError:
        return 0
    rt = (data.get('reference_translation') or '').strip()
    if not rt:
        return 0
    if not re.search(r'\bP\d+\b', rt):
        blocks = [rt] if len(item['paras']) == 1 else []
    else:
        blocks = [b.strip() for b in re.split(r'\bP\d+\b', rt)]
        blocks = [b for b in blocks if b]
    # 首块是一段「这译文怎么来的」说明（模板固定带「参考译文 / 复盘资产」字样），丢掉
    if blocks and ('参考译文' in blocks[0] or '复盘' in blocks[0]):
        blocks = blocks[1:]
    # 末段常被后面的【衔接】讲解串在一起，从【 起全部切掉；
    # 讲解区还会重新出现 P1/P2 这些标记，所以只认前 N 块（N = 段落数）
    blocks = [re.split(r'【', b)[0].strip() for b in blocks]
    blocks = [b for b in blocks if len(b) > 10][:len(item['paras'])]
    if len(blocks) != len(item['paras']):
        return 0
    for para, zh in zip(item['paras'], blocks):
        para['zh'] = zh
    return len(blocks)


def collect_section(conn, paper_id, section, level='', paper_key=''):
    materials = conn.execute(
        """SELECT group_key, content_json, translation_json, analysis_text, directions
           FROM section_materials
           WHERE paper_id=? AND section=? ORDER BY id""",
        (paper_id, section),
    ).fetchall()

    questions = conn.execute(
        """SELECT * FROM questions WHERE paper_id=? AND section=? ORDER BY q_index""",
        (paper_id, section),
    ).fetchall()

    if not questions:
        return None

    # 单材料：全部题目都归它（四六级的 reading1 材料叫 passage、题目却叫 passage1，对不上）
    if len(materials) <= 1:
        groups = [(materials[0]['group_key'] if materials else '', questions)]
        if not materials:
            groups = [('', questions)]
    else:
        # 多材料：按 group_key 对，对不上就按顺序配（考研的 text_1..4 是对得上的）
        by_key = {}
        for q in questions:
            by_key.setdefault(q['group_key'] or '', []).append(q)
        groups = []
        for m in materials:
            qs = by_key.get(m['group_key'])
            if not qs:
                qs = [q for k, v in by_key.items() if k.startswith(m['group_key']) for q in v]
            if qs:
                groups.append((m['group_key'], qs))
        used = {id(q) for _, qs in groups for q in qs}
        left = [q for q in questions if id(q) not in used]
        if left:
            if groups:
                groups[0][1].extend(left)
            else:
                groups.append(('', left))

    passages = []
    sec_label = None
    for gi, (gkey, qs) in enumerate(groups):
        mat = next((m for m in materials if m['group_key'] == gkey), None)
        paras, brief = material_passages(mat, section) if mat else ([], '')
        item = {
            'id': '%s-%d' % (section, gi + 1),
            'paras': paras,
            'questions': [build_question(q) for q in qs],
        }
        if section == 'translation' and mat:
            attach_translation_zh(item, mat, qs, paper_key)
        if section == 'matching' and mat:
            kind, vlabel = matching_variant(mat, qs)
            item['kind'] = kind
            # 变体名只用于考研；四六级 Part B 惯称「长篇阅读」，保持不变
            sec_label = sec_label or (vlabel if level == 'kaoyan' else '长篇阅读')
            try:
                mcj = json.loads(mat['content_json'] or '{}')
            except json.JSONDecodeError:
                mcj = {}
            chain = mcj.get('given_chain') or []
            if kind == 'ordering' and chain:
                item['chain'] = [
                    {'given': c['given']} if 'given' in c else {'no': c['question']}
                    for c in chain
                    if 'given' in c or 'question' in c
                ]
            if kind == 'headings':
                for q in item['questions']:
                    if not q.get('stem'):
                        q['stem'] = '第 %d 段的小标题' % q['no']
            if kind == 'opinions':
                paras_raw = mcj.get('paragraphs') or []
                for q in item['questions']:
                    stem = (q.get('stem') or '').strip()
                    if stem:
                        # 题干已是人名（2024 英语二排版）：补「的观点」
                        if _is_person_name(stem):
                            q['stem'] = '%s 的观点' % stem
                        continue
                    name = _blank_name(paras_raw, q['no'])
                    if name:
                        q['stem'] = '%s 的观点' % name
        if brief:
            item['brief'] = brief
        if section == 'cloze' and mat:
            try:
                bank = json.loads(mat['content_json'] or '{}').get('word_bank') or []
            except json.JSONDecodeError:
                bank = []
            bank = [{'key': b.get('key'), 'text': (b.get('text') or '').strip()} for b in bank if b.get('key')]
            if bank:
                item['bank'] = bank
        cn = ''
        if mat:
            try:
                cn = (json.loads(mat['content_json'] or '{}').get('model_essay_cn') or '').strip()
            except json.JSONDecodeError:
                cn = ''
        if cn:
            item['notes'] = [cn]
        passages.append(item)

    # 整段解析（写作范文、翻译参考英译的讲解）挂在题型上
    notes = [m['analysis_text'].strip() for m in materials if (m['analysis_text'] or '').strip()]
    article = {
        'id': section,
        'label': sec_label or SECTION_LABEL.get(section, section),
        'passages': passages,
    }
    if notes:
        article['notes'] = notes
    return article


def level_of(key):
    if key.startswith('cet4'):
        return 'cet4'
    if 'kaoyan' in key:
        return 'kaoyan'
    return 'cet6'


def exam_label(key, level, year, month, set_no):
    """列表里一眼能分清是哪一场 —— 只写年份的话，6 月和 12 月会混在一起。"""
    if level == 'kaoyan':
        if 'historical' in key:
            return '%d 年 · 早年统考' % year
        return '%d 年 · 英语%s' % (year, '一' if set_no == 1 else '二')
    return '%d 年 %d 月 · 第 %d 套' % (year, month, set_no)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', default='public/training')
    ap.add_argument('--from', dest='since', type=int, default=2016, help='四六级的起始年份')
    ap.add_argument('--kaoyan-from', dest='kaoyan_since', type=int, default=2010,
                    help='考研的起始年份（题库里考研能追到 1998，但 2010 前的卷面结构与现在差太多）')
    ap.add_argument('--levels', default='cet4,cet6,kaoyan')
    ap.add_argument('--limit', type=int, default=0, help='每级最多导几套（0 = 不限）')
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit('找不到题库：%s' % args.db)

    levels = set(x.strip() for x in args.levels.split(',') if x.strip())
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        'SELECT * FROM papers ORDER BY year DESC, month DESC, set_no DESC'
    ).fetchall()

    out_dir = os.path.join(args.out, 'p')
    os.makedirs(out_dir, exist_ok=True)

    index = []
    taken = {lv: 0 for lv in levels}

    for row in rows:
        level = level_of(row['paper_key'])
        if level not in levels:
            continue
        floor = args.kaoyan_since if level == 'kaoyan' else args.since
        if row['year'] < floor:
            continue

        sections = []
        for sec in SECTION_ORDER + EXTRA_SECTIONS.get(level, []):
            art = collect_section(conn, row['id'], sec, level, row['paper_key'])
            if art:
                sections.append(art)
        if not sections:
            continue
        if args.limit and taken[level] >= args.limit:
            continue

        paper = {
            'key': row['paper_key'],
            'level': level,
            'year': row['year'],
            'month': row['month'],
            'setNo': row['set_no'],
            'label': exam_label(row['paper_key'], level, row['year'], row['month'], row['set_no']),
            'sections': sections,
        }

        with open(os.path.join(out_dir, row['paper_key'] + '.json'), 'w', encoding='utf-8') as f:
            json.dump(paper, f, ensure_ascii=False, separators=(',', ':'))

        index.append({
            'key': paper['key'],
            'level': level,
            'year': paper['year'],
            'month': paper['month'],
            'setNo': paper['setNo'],
            'label': paper['label'],
            'sections': [
                {
                    'id': s['id'],
                    'label': s['label'],
                    'questions': sum(len(p['questions']) for p in s['passages']),
                }
                for s in sections
            ],
        })
        taken[level] += 1

    index.sort(key=lambda x: (x['level'], -x['year'], -x['month'], -x['setNo']))

    with open(os.path.join(args.out, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'count': len(index), 'papers': index}, f, ensure_ascii=False, separators=(',', ':'))

    total_q = sum(sum(s['questions'] for s in p['sections']) for p in index)
    print('导出 %d 套 / %d 题，分级：%s' % (
        len(index), total_q, ', '.join('%s=%d' % (k, v) for k, v in sorted(taken.items()))))
    print('索引：%s' % os.path.join(args.out, 'index.json'))


if __name__ == '__main__':
    main()
