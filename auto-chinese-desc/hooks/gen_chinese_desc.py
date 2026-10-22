#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_chinese_desc.py — 为 SKILL.md 生成中文简述（无 AI · 确定性 · 名称为主/内容为辅）

用法：
  无参数      SessionStart hook 入口：扫描、生成、写盘、缓存
  --check     干跑预览：把将发生的修改打到 stderr，不写盘、不写缓存
  --force N   对名为 N 的技能跳过缓存强制重算（可多次传入；纯中文手写描述仍受保护）

设计（按优先级）：
  1. 例外表 data/known.json（技能名→完整中文简述，人工维护）：命中即用，最高置信
  2. 名称翻译：技能名分词 → 最长短语匹配 data/dict.json → 中文同序拼接
     （frontend-design→前端设计、restore-legacy-sessions→恢复旧版会话；停用词跳过、单复数归一）
  3. 内容为辅：名称推出的领域词须在 description/正文标题有印证；名字过泛（如 search）
     时从内容按 词频+标题权重 提取 1-2 个领域词补足
  4. 宁缺毋滥：名称完全无法解析且内容也无术语命中 → 跳过不写并记 stderr，绝不编造
     描述里混有 ≥30 字符连续英文尾巴的旧产物视为待升级，首跑统一重写为「新中文。原英文」

幂等：内容哈希缓存（~/.zcode/auto-chinese-desc/processed.json），处理过的不重写，
人工修改不被覆盖；纯中文描述（无长英文尾巴）永久保护。

注意：stdout 必须保持为空——ZCode 把 hook 的 stdout 当严格 JSON 解析，一律只写 stderr。
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
import time

HOME = os.path.expanduser("~")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "data")
DICT_FILE = os.path.join(DATA_DIR, "dict.json")
KNOWN_FILE = os.path.join(DATA_DIR, "known.json")
CACHE_DIR = os.path.join(HOME, ".zcode", "auto-chinese-desc")
CACHE_FILE = os.path.join(CACHE_DIR, "processed.json")

SKILL_DIRS = [
    os.path.join(HOME, ".agents", "skills"),
    os.path.join(HOME, ".zcode", "cli", "plugins", "cache"),
]

MIN_TAIL = 30          # 中文描述里允许的最长连续非CJK段，超过视为带英文尾巴的旧产物
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
NON_CJK_RUN_RE = re.compile(r"[^\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]+")
ASCII_WORD_RE = re.compile(r"[A-Za-z]{6,}")
TAIL_STRIP = " \t\r\n.,;:!?·…—–-()[]{}\"'`*"


def log(msg):
    print(msg, file=sys.stderr)


def has_cjk(s):
    return bool(CJK_RE.search(s or ""))


def cjk_count(s):
    return len(CJK_RE.findall(s or ""))


def longest_non_cjk(s):
    """最长的连续非CJK片段（中文夹杂英文的描述里，这就是英文尾巴）。并列取最后一段。"""
    best = ""
    for run in NON_CJK_RUN_RE.findall(s or ""):
        stripped = run.strip(TAIL_STRIP)
        if len(stripped) >= len(best):
            best = stripped
    return best


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- frontmatter

def parse_frontmatter(content):
    """返回 (frontmatter文本, 闭合行索引) 或 None。content 必须以 --- 开头。"""
    if not content.startswith("---"):
        return None
    m = re.search(r"^---\s*$", content[3:], re.M)
    if not m:
        return None
    return content[3:3 + m.start()]


def extract_description(fm):
    """从 frontmatter 提取 description，折叠为单行。返回 (desc, 起始行号) 或 (None, None)。"""
    lines = fm.split("\n")
    for i, line in enumerate(lines):
        m = re.match(r"^description:\s*(.*)$", line)
        if not m:
            continue
        val = m.group(1).strip()
        if val in (">", ">-", "|", "|-"):
            parts = []
            j = i + 1
            while j < len(lines) and (lines[j].startswith((" ", "\t")) or lines[j].strip() == ""):
                if lines[j].strip():
                    parts.append(lines[j].strip())
                j += 1
            return " ".join(parts), i
        desc = val.strip("\"'")
        cont = []
        j = i + 1
        while j < len(lines) and lines[j].startswith((" ", "\t")):
            cont.append(lines[j].strip())
            j += 1
        if cont:
            desc = (desc + " " + " ".join(cont)).strip()
        return desc, i
    return None, None


def classify_desc(desc):
    """→ (类别, 英文尾巴或None)。类别: missing / english / legacy / protected

    legacy 判定从严：中文前缀必须靠近开头、且前缀里没有 ≥6 字母的英文单词——
    「布局系统、人工智能。Use this skill...」是旧钩子产物要重写；
    「MUST USE when user wants to 调研/research/...」是人工维护的中英夹杂，不动。
    """
    if not desc or not desc.strip():
        return "missing", None
    desc = desc.strip()
    if not has_cjk(desc):
        return "english", desc
    tail = longest_non_cjk(desc)
    if len(tail) >= MIN_TAIL:
        prefix = desc[: desc.rfind(tail)]
        first_cjk = CJK_RE.search(desc)
        if first_cjk and first_cjk.start() <= 12 and not ASCII_WORD_RE.search(prefix):
            # 保留英文段之后的尾随内容（如 "NOT for 代码评审…"），否则重写时会丢句子
            return "legacy", desc[desc.rfind(tail):]
    return "protected", None


def replace_description(content, text):
    """把 description 块整体替换为折叠标量；无该键则插入 frontmatter 末尾。保留其余字节。"""
    nl = "\r\n" if "\r\n" in content else "\n"
    lines = content.split(nl)
    if lines[0].strip() != "---":
        return None
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return None
    new_block = ["description: >-", "  " + text]
    for i in range(1, end):
        if re.match(r"^description:", lines[i]):
            j = i + 1
            while j < end and lines[j].startswith((" ", "\t")):
                j += 1
            lines[i:j] = new_block
            return nl.join(lines)
    lines[end:end] = new_block
    return nl.join(lines)


# ---------------------------------------------------------------- 名称翻译

def singular(tok):
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith(("ss", "us", "is")):
        return tok[:-1]
    return tok


def translate_name(name, terms, stopwords):
    """技能名 → (cn或None, 分段列表, 置信类别)。分段: (en, cn或None)。"""
    raw = [t for t in re.split(r"[-_.]+", name.strip()) if t]
    lows = [t.lower() for t in raw]
    segs = []
    i = 0
    while i < len(lows):
        hit = None
        for n in (4, 3, 2):
            if i + n <= len(lows):
                ph = " ".join(lows[i:i + n])
                if ph in terms:
                    hit = (ph, terms[ph], n)
                    break
        if hit:
            segs.append((hit[0], hit[1]))
            i += hit[2]
            continue
        tok = lows[i]
        if tok in stopwords and len(lows) > 1:
            i += 1
            continue
        if tok in terms:
            segs.append((tok, terms[tok]))
        else:
            sing = singular(tok)
            if sing in terms:
                segs.append((sing, terms[sing]))
            else:
                segs.append((tok, None))
        i += 1

    parts = []
    for en, cn in segs:
        if cn:
            parts.append(cn)
        else:
            orig = next((r for r in raw if r.lower() == en), en)
            parts.append(orig.upper() if len(orig) <= 4 else orig.capitalize())
    cn = "".join(parts) if parts else None
    resolved = [s for s in segs if s[1]]
    if not segs:
        kind = "empty"
    elif not resolved:
        kind = "unresolved"
    elif len(resolved) < len(segs):
        kind = "partial"
    else:
        kind = "full"
    return cn, segs, kind


# ---------------------------------------------------------------- 内容为辅

HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.M)


def build_content_text(content, desc):
    m = re.search(r"^---\s*$", content[3:], re.M)
    body = content[3 + m.end():] if m else content
    headings = " ".join(HEADING_RE.findall(body))
    text = " ".join([desc or "", headings, body[:1200]])
    return text.lower(), headings.lower(), (desc or "").lower()


def rank_content_terms(text_low, headings_low, desc_low, compiled, exclude_cns, topn):
    """按 标题×3 + 描述×2 + 正文出现 排序取前 topn 个中文术语。"""
    scored = []
    for ph, cn, rx in compiled:
        if cjk_count(cn) < 2 or cn in exclude_cns:
            continue
        if not rx.search(text_low):
            continue
        scored.append((_term_score(cn, compiled, headings_low, desc_low), cn))
    scored.sort(key=lambda x: -x[0])
    out = []
    for score, cn in scored:
        if cn in out:
            continue
        out.append(cn)
        if len(out) >= topn:
            break
    return out


def _term_score(cn, compiled, headings_low, desc_low):
    score = 1
    for ph, c, rx in compiled:
        if c == cn:
            if rx.search(headings_low):
                score += 3
            if rx.search(desc_low):
                score += 2
    return score


def compile_terms(terms):
    out = []
    for ph, cn in terms.items():
        rx = re.compile(r"(?<![a-z0-9_])" + re.escape(ph) + r"(?![a-z0-9_])")
        out.append((ph, cn, rx))
    return out


# ---------------------------------------------------------------- 生成决策

def run_generation(name, content, desc_state, known, compiled, stopwords, generic, terms_map):
    kind, orig = desc_state
    text_low, headings_low, desc_low = build_content_text(content, orig)

    if name in known:
        return known[name], "例外表", "高"

    cn, segs, name_kind = translate_name(name, terms_map, stopwords)

    # 名称完全无法解析 → 内容兜底（需标题或描述命中，宁缺毋滥），否则跳过
    if name_kind in ("empty", "unresolved"):
        hits = rank_content_terms(text_low, headings_low, desc_low, compiled, set(), 3)
        hits = [c for c in hits if cjk_count(c) >= 2
                and (_term_score(c, compiled, headings_low, desc_low) >= 2)]
        if hits:
            return "、".join(hits) + "相关技能", "内容兜底", "中"
        return None, "跳过", "低"

    # 名字过泛（单词且译文属泛词）→ 内容补足
    if name_kind == "full" and len(segs) == 1 and cn in generic:
        extra = rank_content_terms(text_low, headings_low, desc_low, compiled, {cn}, 2)
        if extra:
            cn = cn + "：" + "、".join(extra)

    # 内容印证：名称任一英文成分出现在正文/标题/描述中
    verified = any(
        re.search(r"(?<![a-z0-9_])" + re.escape(en) + r"(?![a-z0-9_])", text_low)
        for en, c in segs if c
    ) or any(
        w in text_low
        for en, c in segs if c
        for w in en.split() if len(w) >= 4
    )
    conf = "高" if verified else "中"
    return cn, "名称", conf


# ---------------------------------------------------------------- 扫描与主流程

def find_skill_files():
    files = []
    for d in SKILL_DIRS:
        if not os.path.exists(d):
            continue
        for root, dirs, _ in os.walk(d):
            if "node_modules" in dirs:
                dirs.remove("node_modules")
            files.extend(glob.glob(os.path.join(root, "SKILL.md")))
    return sorted(set(files))


def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("version") == 1:
            return data.get("entries", {})
    except (OSError, ValueError):
        pass
    return {}


def save_cache(entries):
    os.makedirs(CACHE_DIR, exist_ok=True)
    payload = {"version": 1, "entries": entries}
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CACHE_FILE)


def sha1_bytes(b):
    return hashlib.sha1(b).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="干跑预览，不写盘")
    ap.add_argument("--force", action="append", default=[], metavar="NAME",
                    help="强制重算指定技能名（可多次）")
    args = ap.parse_args()

    try:
        DICT = load_json(DICT_FILE)
        known = load_json(KNOWN_FILE)
    except (OSError, ValueError) as e:
        log(f"[auto-chinese-desc] 数据文件加载失败: {e}")
        sys.exit(1)
    terms_map = DICT["terms"]
    stopwords = set(DICT.get("stopwords", []))
    generic = set(DICT.get("generic", []))
    compiled = compile_terms(terms_map)

    cache = {} if args.check else load_cache()
    stats = {"written": 0, "protected": 0, "skipped": 0, "cached": 0, "check": 0}
    files = find_skill_files()
    mode = "干跑预览" if args.check else "执行"

    for path in files:
        name = os.path.basename(os.path.dirname(path))
        rel = os.path.relpath(path, HOME)
        try:
            raw = open(path, "rb").read()
        except OSError as e:
            log(f"[auto-chinese-desc] ! 读取失败 {rel}: {e}")
            continue
        try:
            content = raw.decode("utf-8-sig")
        except UnicodeDecodeError as e:
            log(f"[auto-chinese-desc] ! 非UTF-8，跳过 {rel}: {e}")
            continue

        sha = sha1_bytes(raw)
        forced = name in args.force
        if sha in cache and not forced:
            stats["cached"] += 1
            continue

        fm = parse_frontmatter(content)
        if fm is None:
            log(f"[auto-chinese-desc] ? 无 frontmatter，跳过 {rel}")
            continue
        desc, _ = extract_description(fm)
        kind, orig = classify_desc(desc)

        if kind == "protected" and not forced:
            stats["protected"] += 1
            if not args.check:
                cache[sha] = {"n": name, "s": "protected", "t": int(time.time())}
            continue

        new_cn, source, conf = run_generation(
            name, content, (kind, orig), known, compiled, stopwords, generic, terms_map)

        if new_cn is None:
            stats["skipped"] += 1
            log(f"[auto-chinese-desc] ? 跳过 {name}（{rel}）：名称与内容均无可靠信号，保持英文")
            continue

        full_desc = f"{new_cn}。{orig}" if orig else new_cn

        if args.check:
            stats["check"] += 1
            old_show = (desc or "(无)")[:60]
            log(f"  [{source}/{conf}] {name}\n"
                f"      旧: {old_show}\n"
                f"      新: {full_desc[:90]}")
            continue

        new_content = replace_description(content, full_desc)
        if new_content is None:
            log(f"[auto-chinese-desc] ! frontmatter 异常，跳过 {rel}")
            continue
        try:
            with open(path, "wb") as f:
                f.write(new_content.encode("utf-8"))
        except OSError as e:
            log(f"[auto-chinese-desc] ! 写入失败 {rel}: {e}")
            continue
        cache[sha1_bytes(new_content.encode("utf-8"))] = {
            "n": name, "s": source, "t": int(time.time())}
        stats["written"] += 1
        log(f"[auto-chinese-desc] + {name}: {new_cn}  [{source}/{conf}]")

    if not args.check:
        try:
            save_cache(cache)
        except OSError as e:
            log(f"[auto-chinese-desc] ! 缓存写入失败: {e}")

    s = stats
    log(f"[auto-chinese-desc] {mode}完成：文件 {len(files)} | "
        f"写入 {s['written']} | 保护 {s['protected']} | 跳过 {s['skipped']} | "
        f"缓存命中 {s['cached']}" + (f" | 预览 {s['check']}" if args.check else ""))


if __name__ == "__main__":
    main()
