"""Regenerate `dataframe-html-reprs.json`: VERBATIM `text/html` reprs from real
pandas and polars.

`$lib/dataframeHtml` exists to read what those two libraries actually emit, so its
tests are driven by captured output rather than by hand-typed HTML - which would be
the parser's own assumptions written out a second time, and is exactly how the
missing-column bug survived (the old fixture gave a MultiIndex-row table ONE blank
leading `<th>` where pandas emits one per level).

    uv venv .venv && uv pip install -p .venv/bin/python 'pandas==2.3.3' polars matplotlib
    .venv/bin/python dataframe-html-reprs.gen.py dataframe-html-reprs.json

Deterministic: every Styler is given a fixed uuid, since pandas mints a random
`id="T_<hex>"` per render (which is also why the parser must never key on it).
"""
import datetime as dt
import json
import sys

import numpy as np
import pandas as pd
import polars as pl

out = {}

# --- the reported shape: a 17-column polars frame whose first column vanished ---
CAPTAIN_COLS = [
    "uuid", "bidder_id", "bid_round", "floor", "market_floor", "delta", "win",
    "impressions", "revenue", "ctr", "segment", "device", "country", "hour",
    "model_v", "score", "ts",
]
captain = pl.DataFrame({
    "uuid": ["a1b2c3", "d4e5f6", "071819"],
    "bidder_id": ["5006", "5006", "3788"],
    "bid_round": [1, 2, 1],
    "floor": [0.15, 0.22, 0.31],
    "market_floor": [0.14, 0.25, 0.29],
    "delta": [0.01, -0.03, 0.02],
    "win": [True, False, True],
    "impressions": [1200, 980, 1500],
    "revenue": [18.4, 0.0, 27.15],
    "ctr": [0.012, 0.0, 0.018],
    "segment": ["video", "video", "display"],
    "device": ["ctv", "mobile", "ctv"],
    "country": ["US", "US", "CA"],
    "hour": [3, 14, 22],
    "model_v": ["v2", "v2", "v3"],
    "score": [0.884, 0.211, 0.905],
    "ts": [dt.datetime(2026, 1, 2, 3, 4, 5)] * 3,
})
out["polars_captain_17col"] = captain._repr_html_()
out["polars_captain_columns"] = CAPTAIN_COLS

out["polars_small"] = pl.DataFrame({"a": [1, 2], "b": ["x", "y"]})._repr_html_()
out["polars_quotes_nulls"] = pl.DataFrame(
    {"id": ["5006", None, "007"], "n": [1, None, 3], "say": ['say "hi"', "", None]}
)._repr_html_()
out["polars_row_truncation"] = pl.DataFrame(
    {"i": list(range(40)), "s": [f"v{i}" for i in range(40)]}
)._repr_html_()
out["polars_col_truncation"] = pl.DataFrame({f"c{i}": [1, 2] for i in range(100)})._repr_html_()
out["polars_empty"] = pl.DataFrame({"a": [], "b": []})._repr_html_()
# Zero rows AND wide enough for the repr to truncate columns: the empty body has no
# index to read, and the declared shape legitimately disagrees with the parsed count
# (truncation), so only polars' own dtype row can say there is no index column.
out["polars_empty_col_truncation"] = pl.DataFrame(
    {f"c{i}": [] for i in range(100)}
)._repr_html_()
out["polars_series"] = pl.Series("s", [1, 2, 3])._repr_html_()
out["polars_dtypes"] = pl.DataFrame(
    {"d": [dt.date(2020, 1, 1)], "f": [1.5], "b": [True], "l": [[1, 2]]}
)._repr_html_()

# --- pandas: the side that must not regress ---
pdf = pd.DataFrame({"a": [1, 2], "b": ["x", "y"]})
out["pandas_plain"] = pdf._repr_html_()
out["pandas_to_html_no_index"] = pdf.to_html(index=False)
out["pandas_named_index"] = pdf.set_index("a")._repr_html_()
_cn = pd.DataFrame({"a": [1], "b": [2]})
_cn.columns.name = "COLS"
out["pandas_columns_name"] = _cn._repr_html_()
out["pandas_empty_4col"] = pd.DataFrame(columns=["a", "b", "c", "d"])._repr_html_()
# Zero rows and NO index placeholder: the header's first cell is a real column, so
# nothing distinguishes it from a `columns.name` placeholder. Must refuse.
out["pandas_empty_no_index"] = pd.DataFrame(columns=["a", "b"]).to_html(index=False)
out["pandas_row_truncation"] = pd.DataFrame({"v": range(200)})._repr_html_()
out["pandas_col_truncation"] = pd.DataFrame(
    np.arange(60).reshape(2, 30), columns=[f"c{i}" for i in range(30)]
)._repr_html_()
out["pandas_multiindex_rows"] = pd.DataFrame(
    {"v": [1, 2]}, index=pd.MultiIndex.from_tuples([("a", 1), ("a", 2)])
)._repr_html_()
out["pandas_multiindex_cols"] = pd.DataFrame(
    [[1, 2, 3, 4]], columns=pd.MultiIndex.from_tuples([("A", "x"), ("A", "y"), ("B", "x"), ("B", "y")])
)._repr_html_()
out["pandas_multiindex_cols_named"] = pd.DataFrame(
    [[1, 2]], columns=pd.MultiIndex.from_tuples([("A", "x"), ("A", "y")], names=["top", "bot"])
)._repr_html_()

# --- pandas Styler: not a DataFrame, so the kernel formatter never sees it ---
t = pd.DataFrame({"rev": [1234.5, 98765.25], "share": [0.1234, 0.8766]}, index=["a", "b"])
fmt = {"rev": "{:,.2f}", "share": "{:.1%}"}
out["styler_plain"] = t.style.set_uuid("fx").set_caption("Revenue by arm").format(fmt)._repr_html_()
out["styler_hide_index"] = (
    t.style.set_uuid("fx").set_caption("Floors").format(fmt).hide(axis="index")._repr_html_()
)
out["styler_gradient"] = t.style.set_uuid("fx").background_gradient(cmap="Blues")._repr_html_()
out["styler_named_index"] = (
    pd.DataFrame({"v": [1, 2]}, index=pd.Index(["a", "b"], name="k")).style.set_uuid("fx")._repr_html_()
)
out["styler_multiindex_cols"] = (
    pd.DataFrame([[1, 2, 3, 4]], columns=pd.MultiIndex.from_tuples([("A", "x"), ("A", "y"), ("B", "x"), ("B", "y")]))
    .style.set_uuid("fx")
    ._repr_html_()
)
out["styler_bare"] = pd.DataFrame({"a": [1, 2], "b": ["x", "y"]}).style.set_uuid("fx")._repr_html_()

# `Styler.format` defaults to escape=None, so a formatter may put the user's own
# MARKUP in a cell - which `textContent` flattens (a link) or empties (an image).
_links = pd.DataFrame({"name": ["a", "b"], "url": ["https://x/1", "https://x/2"]})
out["styler_cell_link"] = (
    _links.style.set_uuid("fx").format({"url": lambda u: f'<a href="{u}">link</a>'})._repr_html_()
)
_sparks = pd.DataFrame({"k": ["a", "b"], "spark": ["1", "2"]})
out["styler_cell_img"] = (
    _sparks.style.set_uuid("fx")
    .format({"spark": lambda v: f'<img src="data:image/gif;base64,R0lGOD{v}" />'})
    ._repr_html_()
)
# `set_table_attributes('class="dataframe"')` is a documented Styler idiom, so the
# SAME markup-bearing Styler can be resolved by the `table.dataframe` lookup rather
# than by the `col_heading` one. Still a Styler; must still fall back.
out["styler_dataframe_class_cell_link"] = (
    _links.style.set_uuid("fx")
    .set_table_attributes('class="dataframe"')
    .format({"url": lambda u: f'<a href="{u}">link</a>'})
    ._repr_html_()
)
out["styler_dataframe_class_cell_img"] = (
    _sparks.style.set_uuid("fx")
    .set_table_attributes('class="dataframe"')
    .format({"spark": lambda v: f'<img src="data:image/gif;base64,R0lGOD{v}" />'})
    ._repr_html_()
)
# The same idiom with TEXT cells, which must still reach the grid - so the refusal
# above is attributable to the markup rather than to the class.
out["styler_dataframe_class_plain"] = (
    t.style.set_uuid("fx")
    .set_table_attributes('class="dataframe"')
    .set_caption("Revenue by arm")
    .format(fmt)
    ._repr_html_()
)

out["_versions"] = {"pandas": pd.__version__, "polars": pl.__version__}
with open(sys.argv[1], "w") as fh:
    json.dump(out, fh, indent=1, ensure_ascii=False)
    fh.write("\n")
print("wrote", sys.argv[1], "keys:", len(out))
