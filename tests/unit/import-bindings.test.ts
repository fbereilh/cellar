/**
 * The pure half of the imports-staleness refinement: WHICH names a cell provides
 * as module-level import bindings, and WHEN each one last changed.
 *
 * Two contracts, and they fail in opposite directions - a rule that satisfies only
 * one of them is not a fix:
 *
 *   PRECISION - a binding that is byte-identical before and after an edit keeps its
 *   old stamp, so re-rendering, reordering, or re-adding an import that was already
 *   there (what agent import-routing does constantly) marks nothing changed.
 *
 *   SAFETY - anything we cannot PROVE stable is stamped changed. A removal is a
 *   change (forgetting it is the false `fresh` this exists to prevent), and a source
 *   whose binding set is unknowable (`import *`, or a cell that is not imports-only,
 *   so an ordinary statement might rebind the name) yields no stable bindings at all.
 */
import { describe, it, expect } from 'vitest';
import {
	importBindingSpecs,
	importBindingNames,
	foldImportChange,
	pruneImportBindings,
	type ImportChangeStamps
} from '../../src/lib/server/importBindings';

const specs = (src: string) => {
	const m = importBindingSpecs(src);
	return m && Object.fromEntries(m);
};

describe('importBindingSpecs - which names a source provides', () => {
	it('maps each bound name to its canonical statement', () => {
		expect(specs('import pandas as pd\nfrom os.path import join')).toEqual({
			pd: 'import pandas as pd',
			join: 'from os.path import join'
		});
	});

	it('binds the ROOT package for a dotted import', () => {
		expect(specs('import os.path')).toEqual({ os: 'import os.path' });
		expect(specs('import numpy.random as npr')).toEqual({ npr: 'import numpy.random as npr' });
	});

	it('keeps comments and blank lines out of the way', () => {
		expect(specs('# stdlib\n\nimport os  # noqa\n')).toEqual({ os: 'import os' });
	});

	it('expands a multi-name statement into one binding per name', () => {
		expect(specs('from a import b, c as d')).toEqual({
			b: 'from a import b',
			d: 'from a import c as d'
		});
	});

	it('is UNKNOWABLE for a star import (it binds names nobody can enumerate)', () => {
		expect(importBindingSpecs('from os.path import *')).toBeNull();
		expect(importBindingNames('import os\nfrom os.path import *')).toEqual([]);
	});

	it('is UNKNOWABLE for a cell that is not imports-only', () => {
		// Anything else at module scope could rebind an imported name, and proving it
		// does not would mean re-deriving Python's binding rules with a regex.
		expect(importBindingSpecs('import os\nos = shim')).toBeNull();
		expect(importBindingSpecs('import os\nprint(os)')).toBeNull();
		expect(importBindingSpecs('import os\nfor os in xs:\n    pass')).toBeNull();
	});

	it('is UNKNOWABLE for an indented (non-module-level) import', () => {
		// A nested import is a deliberate choice and binds inside its own scope; the
		// surrounding try/if is also non-import module-level code.
		expect(importBindingSpecs('try:\n    import ujson as json\nexcept ImportError:\n    import json')).toBeNull();
	});

	it('never sees an import that only LOOKS like one', () => {
		// `logicalLines` understands string literals, so neither of these is an import.
		// Both are also non-import module-level code, so both read UNKNOWABLE - the
		// conservative answer, and never a phantom `evil` binding.
		expect(importBindingNames('"""\nimport evil\n"""')).toEqual([]);
		expect(importBindingNames('s = "import evil"')).toEqual([]);
	});

	it('lets a later duplicate binding win, like Python', () => {
		expect(specs('import json\nimport ujson as json')).toEqual({ json: 'import ujson as json' });
	});

	it('DISCOUNTS only the line magics PROVEN to bind nothing (plus shell escapes)', () => {
		// `%matplotlib inline` above the import block is one of the commonest notebook
		// headers there is. Treating it as "other code" would degrade the whole map to
		// null and leave the reported bug unfixed for most real notebooks.
		expect(specs('%matplotlib inline\nimport pandas as pd')).toEqual({ pd: 'import pandas as pd' });
		expect(specs('%pip install polars\n!ls\nimport os')).toEqual({ os: 'import os' });
		expect(specs('%config InlineBackend.figure_format = "retina"\nimport os')).toEqual({
			os: 'import os'
		});
	});

	it('is UNKNOWABLE for a magic that injects names into the namespace', () => {
		// `%run setup.py` executes the script IN the user namespace, so it can rebind an
		// imported name (`pd = wrap(pd)`) exactly like `os = shim` - the shadow the
		// imports-only test exists to refuse. Same for the other injectors.
		expect(importBindingSpecs('import pandas as pd\n%run setup.py')).toBeNull();
		expect(importBindingSpecs('%store -r pd\nimport os')).toBeNull();
		expect(importBindingSpecs('%load helpers.py\nimport os')).toBeNull();
		expect(importBindingSpecs('%pylab inline\nimport os')).toBeNull();
	});

	it('is UNKNOWABLE for an UNRECOGNIZED magic - the allowlist fails conservative', () => {
		// The discount is an allowlist, not a denylist: a magic nobody here has heard of
		// (a future IPython one, an extension's own) must cost a needless re-run, never
		// certify a name it may have rebound as unchanged.
		expect(importBindingSpecs('%mystery_magic\nimport os')).toBeNull();
		expect(importBindingSpecs('import os\n%sql SELECT 1')).toBeNull();
	});

	it('still refuses the ASSIGNMENT form of a magic, which does bind', () => {
		// `files = !ls` binds `files`, so the cell is ordinary code again - and a cell
		// that binds anything outside its imports could rebind an imported name.
		expect(importBindingSpecs('import os\nfiles = !ls')).toBeNull();
		expect(importBindingSpecs('import os\nt = %timeit -o f()')).toBeNull();
	});

	it('is UNKNOWABLE for a cell magic, whose body is not module-level Python', () => {
		expect(importBindingSpecs('%%bash\nimport os')).toBeNull();
		expect(importBindingSpecs('%%time\nimport os')).toBeNull();
	});

	it('is UNKNOWABLE for a cell arming %autoreload, which un-does import idempotence', () => {
		// The exemption rests on "re-executing an import rebinds the same object";
		// autoreload exists precisely to break that, so such a cell keeps the
		// conservative cell-level rule (documented in staleness.ts KNOWN LIMITS).
		expect(importBindingSpecs('%load_ext autoreload\n%autoreload 2\nimport pandas as pd')).toBeNull();
		expect(importBindingSpecs('%reload_ext autoreload\nimport os')).toBeNull();
		expect(importBindingSpecs('%autoreload 0\nimport os')).toBeNull();
	});

	it('is UNKNOWABLE for ANY %load_ext - an extension may push names of its own', () => {
		// `%load_ext x` runs x's `load_ipython_extension(ip)`, which is free to call
		// `ip.push({...})`, so it is the one entry on the allowlist that would have been
		// arbitrary code. The allowlist's bar is proof, not "the ones I know are quiet".
		expect(importBindingSpecs('%load_ext sql\nimport os')).toBeNull();
		expect(importBindingSpecs('%reload_ext line_profiler\nimport os')).toBeNull();
		// The ubiquitous header that DOES stay analyzable, so the refinement is not lost.
		expect(specs('%matplotlib inline\nimport os')).toEqual({ os: 'import os' });
	});
});

describe('foldImportChange - when each binding last changed', () => {
	const NOW = 5000;
	/** name → the ms stamp, dropping the baseline spec each entry also carries. */
	const stamps = (out: ImportChangeStamps) =>
		Object.fromEntries(Object.entries(out).map(([name, b]) => [name, b.at]));
	/** name → when it stopped being provided; only removals appear. */
	const removals = (out: ImportChangeStamps) =>
		Object.fromEntries(
			Object.entries(out)
				.filter(([, b]) => b.removedAt != null)
				.map(([name, b]) => [name, b.removedAt])
		);

	it('stamps nothing when the bindings survive a rewrite', () => {
		// Reordered and re-rendered - the same two bindings. This is the routing case.
		const out = foldImportChange('import pandas as pd\nimport numpy as np', 'import numpy as np\nimport pandas as pd', {}, NOW);
		expect(stamps(out)).toEqual({ pd: 0, np: 0 });
	});

	it('stamps only the name that was ADDED', () => {
		const out = foldImportChange('import pandas as pd', 'import pandas as pd\nimport re', {}, NOW);
		expect(stamps(out)).toEqual({ pd: 0, re: NOW });
	});

	it('stamps only the name that was REBOUND', () => {
		const out = foldImportChange('import numpy as np\nimport pandas as pd', 'import numpy.random as np\nimport pandas as pd', {}, NOW);
		expect(stamps(out)).toEqual({ np: NOW, pd: 0 });
	});

	it('records WHEN a name was REMOVED and KEEPS it in the map', () => {
		// The entry is what tells staleness a reader of `np` must be re-run; dropping
		// it leaves that reader with no definer at all, i.e. a false `fresh`. The spec
		// survives the removal so a later restore can be recognized as one.
		const out = foldImportChange('import numpy as np\nimport pandas as pd', 'import pandas as pd', {}, NOW);
		expect(out.np).toEqual({ spec: 'import numpy as np', at: 0, sinceAt: 0, removedAt: NOW });
		expect(removals(out)).toEqual({ np: NOW });
	});

	it('keeps the FIRST removal time across later edits that leave the name absent', () => {
		const gone = foldImportChange('import numpy as np\nimport os', 'import os', {}, 100);
		const later = foldImportChange('import os', 'import os\nimport re', gone, NOW);
		expect(removals(later)).toEqual({ np: 100 }); // when it left, not when we last looked
	});

	it('carries a prior stamp forward for a binding this edit did not touch', () => {
		const prev = { pd: { spec: 'import pandas as pd', at: 100 } };
		const out = foldImportChange('import pandas as pd', 'import pandas as pd\nimport re', prev, NOW);
		expect(stamps(out)).toEqual({ pd: 100, re: NOW });
	});

	it('UNDOES a removal that the same content restores (select-all, delete, retype)', () => {
		// The other transient save shape: an EMPTY source is perfectly knowable, so it
		// cannot be frozen like an unparseable one without losing a genuine "delete all
		// imports". Instead the removal is recorded but stays undoable - retyping the
		// identical block clears it and stamps nothing, so a round trip that ends
		// byte-identical to where it started leaves the notebook exactly as it was.
		const gone = foldImportChange('import numpy as np', '', {}, 100);
		expect(removals(gone)).toEqual({ np: 100 });
		expect(stamps(gone)).toEqual({ np: 0 });

		const back = foldImportChange('', 'import numpy as np', gone, NOW);
		expect(removals(back)).toEqual({});
		expect(stamps(back)).toEqual({ np: 0 });
	});

	it('treats a REBINDING across that window as the real change it is', () => {
		const gone = foldImportChange('import numpy as np', '', {}, 100);
		const back = foldImportChange('', 'import numpy.random as np', gone, NOW);
		expect(removals(back)).toEqual({});
		expect(stamps(back)).toEqual({ np: NOW });
	});

	it('stamps every name the new source binds when the BASELINE is unknowable', () => {
		// Nothing was ever proven about this cell, so nothing may be certified stable.
		expect(stamps(foldImportChange('import os\nprint(os)', 'import os', {}, NOW))).toEqual({ os: NOW });
	});

	it('FREEZES the baseline while the source is unknowable, and re-diffs against it after', () => {
		// The mid-edit case: Cell.svelte autosaves on a 500ms debounce, so a bare
		// `import ` (or the instant after a select-all) really is persisted. Stamping
		// everything there - and again on the next fold, for want of a knowable
		// previous source - would re-stale the whole notebook on an edit that ended up
		// changing one line, which is the blanket-stale this mechanism exists to remove.
		const good = 'import json\nimport pandas as pd';
		const settled = foldImportChange('', good, undefined, 100);
		expect(stamps(settled)).toEqual({ json: 100, pd: 100 });

		const midEdit = foldImportChange(good, 'import ', settled, 2000);
		expect(stamps(midEdit)).toEqual({ json: 100, pd: 100 }); // untouched
		// Same for a source that parses but binds unknowable names: freezing is safe
		// because a cell whose CURRENT source is unknowable provides no import binding
		// for staleness to exempt, so every edge out of it stays conservative anyway.
		expect(stamps(foldImportChange(good, `${good}\nfrom x import *`, settled, 2000))).toEqual({
			json: 100,
			pd: 100
		});

		// Back to the SAME content: nothing changed, so nothing is re-stamped.
		expect(stamps(foldImportChange('import ', good, midEdit, NOW))).toEqual({ json: 100, pd: 100 });
		// And a real change made across that window still lands on its own name only.
		expect(stamps(foldImportChange('import ', `${good}\nimport re`, midEdit, NOW))).toEqual({
			json: 100,
			pd: 100,
			re: NOW
		});
	});

	it('seeds a frozen baseline from the previous source when the cell has no stamps yet', () => {
		// The very first edit of a freshly loaded notebook (runtime stamps are stripped
		// on read) can itself be the unknowable one. Without materializing the baseline
		// here, the NEXT fold would have neither stamps nor a knowable previous source.
		const frozen = foldImportChange('import json\nimport pandas as pd', 'impor', undefined, 2000);
		expect(stamps(frozen)).toEqual({ json: 0, pd: 0 });
		expect(stamps(foldImportChange('impor', 'import json\nimport pandas as pd', frozen, NOW))).toEqual({
			json: 0,
			pd: 0
		});
	});

	it('records WHEN a name first appeared, separately from when it was rebound', () => {
		// `at` moves on every rebinding; `sinceAt` must not, or a long-standing binding
		// that was rebound once would look newborn to the prune below.
		const born = foldImportChange('', 'import numpy as np', undefined, 100);
		expect(born.np).toEqual({ spec: 'import numpy as np', at: 100, sinceAt: 0 });
		const rebound = foldImportChange('import numpy as np', 'import numpy.random as np', born, NOW);
		expect(rebound.np).toEqual({ spec: 'import numpy.random as np', at: NOW, sinceAt: 0 });
	});

	it('a name that appears only BETWEEN two folds is born now, not "here all along"', () => {
		const settled = foldImportChange('', 'import numpy as np', { np: { spec: 'import numpy as np', at: 0, sinceAt: 0 } }, 100);
		const added = foldImportChange('import numpy as np', 'import numpy as np\nimport re', settled, NOW);
		expect(added.re).toEqual({ spec: 'import re', at: NOW, sinceAt: NOW });
	});
});

describe('pruneImportBindings - which removal records are worth remembering', () => {
	const RAN_AT = 1000;

	it('DROPS a name born and removed between two runs (a debounced mid-edit phantom)', () => {
		// Retyping `import numpy as np` persists `import numpy as n` on the way through,
		// so `n` is minted and removed a keystroke later. Nothing ran while it existed,
		// so no downstream cell can have read it - and left in the map it would grow the
		// map forever AND make the removal ledger report a removal that never happened
		// for any cell that uses a name spelled `n`.
		const born = foldImportChange('import numpy as np', 'import numpy as n', {}, RAN_AT + 10);
		const gone = foldImportChange('import numpy as n', 'import numpy as np', born, RAN_AT + 20);
		expect(gone.n?.removedAt).toBe(RAN_AT + 20); // the fold still records it…
		expect(pruneImportBindings(gone, RAN_AT)).toEqual({
			np: { spec: 'import numpy as np', at: 0, sinceAt: 0 }
		}); // …and the prune is what forgets it
	});

	it('KEEPS the removal of a name that WAS bound when the cell last ran', () => {
		// The half that must never be traded away: a genuinely deleted import has to keep
		// staling its readers, and they have no definer left to reach it by any other
		// route. Pruning "every name the current source lacks" would delete exactly this.
		const gone = foldImportChange('import numpy as np\nimport os', 'import os', {}, RAN_AT + 10);
		expect(pruneImportBindings(gone, RAN_AT).np).toEqual({
			spec: 'import numpy as np',
			at: 0,
			sinceAt: 0,
			removedAt: RAN_AT + 10
		});
	});

	it('KEEPS a removal even when the name was REBOUND after that run', () => {
		// `at` is past the run but `sinceAt` is not: the name WAS bound when the cell ran
		// (under its old spec), so its readers consumed it and its removal still counts.
		const rebound = foldImportChange('import numpy as np', 'import numpy.random as np', {}, RAN_AT + 10);
		const gone = foldImportChange('import numpy.random as np', '', rebound, RAN_AT + 20);
		expect(pruneImportBindings(gone, RAN_AT).np?.removedAt).toBe(RAN_AT + 20);
	});

	it('never touches a name the cell still provides', () => {
		const out = foldImportChange('', 'import os\nimport re', undefined, RAN_AT + 10);
		expect(pruneImportBindings(out, null)).toEqual(out); // nothing removed ⇒ nothing to prune
	});

	it('drops the removals of a cell that has never run - it bound nothing to consume', () => {
		const gone = foldImportChange('import numpy as np', '', {}, RAN_AT);
		expect(pruneImportBindings(gone, null)).toEqual({});
	});

	it('keeps a legacy entry that predates sinceAt rather than guessing', () => {
		const legacy: ImportChangeStamps = { np: { spec: 'import numpy as np', at: 0, removedAt: 900 } };
		expect(pruneImportBindings(legacy, RAN_AT)).toEqual(legacy);
	});
});

describe('foldImportChange - housekeeping', () => {
	const NOW = 5000;

	it('keeps an ordinary code cell out of the map entirely', () => {
		// Never imports-only ⇒ nothing knowable, nothing stored: the map stays empty so
		// no stamp rides every cell:edited event or checkpoint snapshot for a cell that
		// binds no imports at all.
		expect(foldImportChange('df = load()', 'df = load()\ndf.head()', undefined, NOW)).toEqual({});
	});
});
