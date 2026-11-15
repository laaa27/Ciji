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
    'listening': '听力',
    'cloze': '完形填空',
    'matching': '长篇阅读',
    'reading1': '阅读理解',
    'reading2': '阅读理解',
    'writing': '写作',
    'translation': '翻译',
}
SECTION_ORDER = ['listening', 'cloze', 'matching', 'reading1', 'reading2', 'writing', 'translation']

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

    opts = parse_options(blocks.get('选项'))
    if opts:
        out['options'] = opts

    rest = '\n'.join(blocks.get('解析', [])).strip()
    if rest:
        out['note'] = rest
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


def material_passages(row, section):
    """把一条 section_materials 的 content_json 变成若干段落（每段是句子数组）。

    同时返回 brief：写作/翻译的题目要求（中文或英文指令），单独一行显示，
    不掺进正文 —— 正文要能逐词点查，题干混进去会让"这个词该不该点"变得模糊。
    """
    try:
        data = json.loads(row['content_json'] or '{}')
    except json.JSONDecodeError:
        return [], ''
    brief = (data.get('prompt') or '').strip()

    # 听力：groups[].lines[{speaker,en,cn}]，本身就是逐句中英
    if section == 'listening':
        paras = []
        for g in data.get('groups') or []:
            sentences = []
            for line in g.get('lines') or []:
                en = (line.get('en') or '').strip()
                if not en:
                    continue
                item = {'en': (line.get('speaker') + ': ' if line.get('speaker') else '') + en}
                cn = (line.get('cn') or '').strip()
                if cn:
                    item['zh'] = cn
                sentences.append(item)
            if sentences:
                paras.append(sentences)
        return paras, brief

    # 信息匹配：段落带 A/B/C… 标号，一段一段给
    if isinstance(data.get('paragraphs'), list):
        paras = []
        for p in data['paragraphs']:
            txt = (p.get('text') or '').strip()
            if not txt:
                continue
            label = (p.get('label') or '').strip()
            sents = [{'en': s} for s in split_sentences(txt)]
            if sents:
                if label:
                    sents[0]['label'] = label
                paras.append(sents)
        return paras, brief

    # 普通文章：一段字符串，按标点切句后每 4 句归一段（与阅读页同一节奏）
    text = (data.get('passage') or '').strip()
    if text:
        sents = [{'en': s} for s in split_sentences(text)]
        return [sents[i:i + 4] for i in range(0, len(sents), 4)], brief

    # 写作 / 翻译：题面单独给，正文是范文或参考译文
    body = data.get('model_essay') or data.get('reference_translation') or ''
    if body.strip():
        sents = [{'en': s} for s in split_sentences(body)]
        return [sents[i:i + 4] for i in range(0, len(sents), 4)], brief

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


def collect_section(conn, paper_id, section):
    materials = conn.execute(
        """SELECT group_key, content_json, analysis_text FROM section_materials
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
    for gi, (gkey, qs) in enumerate(groups):
        mat = next((m for m in materials if m['group_key'] == gkey), None)
        paras, brief = material_passages(mat, section) if mat else ([], '')
        item = {
            'id': '%s-%d' % (section, gi + 1),
            'paras': paras,
            'questions': [build_question(q) for q in qs],
        }
        if brief:
            item['brief'] = brief
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
        'label': SECTION_LABEL.get(section, section),
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


def exam_label(key, level, year, set_no):
    if level == 'kaoyan':
        if 'historical' in key:
            return '%d 年考研英语（早年统考）' % year
        return '%d 年考研英语%s' % (year, '一' if set_no == 1 else '二')
    return '%d 年%s第%d套' % (year, '四级' if level == 'cet4' else '六级', set_no)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', default='public/training')
    ap.add_argument('--from', dest='since', type=int, default=2024, help='只导这一年及以后的卷')
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
        if row['year'] < args.since:
            continue
        if args.limit and taken[level] >= args.limit:
            continue

        sections = []
        for sec in SECTION_ORDER:
            art = collect_section(conn, row['id'], sec)
            if art:
                sections.append(art)
        if not sections:
            continue

        paper = {
            'key': row['paper_key'],
            'level': level,
            'year': row['year'],
            'month': row['month'],
            'setNo': row['set_no'],
            'label': exam_label(row['paper_key'], level, row['year'], row['set_no']),
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
