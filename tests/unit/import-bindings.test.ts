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
	foldImportChange
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
});

describe('foldImportChange - when each binding last changed', () => {
	const NOW = 5000;
	/** name → the ms stamp, dropping the baseline spec each entry also carries. */
	const stamps = (out: Record<string, { spec: string | null; at: number }>) =>
		Object.fromEntries(Object.entries(out).map(([name, b]) => [name, b.at]));

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

	it('stamps a REMOVED name and KEEPS it in the map', () => {
		// The entry is what tells staleness a reader of `np` must be re-run; dropping
		// it leaves that reader with no definer at all, i.e. a false `fresh`.
		const out = foldImportChange('import numpy as np\nimport pandas as pd', 'import pandas as pd', {}, NOW);
		expect(out.np).toEqual({ spec: null, at: NOW });
		expect(stamps(out)).toEqual({ np: NOW, pd: 0 });
	});

	it('carries a prior stamp forward for a binding this edit did not touch', () => {
		const prev = { pd: { spec: 'import pandas as pd', at: 100 } };
		const out = foldImportChange('import pandas as pd', 'import pandas as pd\nimport re', prev, NOW);
		expect(stamps(out)).toEqual({ pd: 100, re: NOW });
	});

	it('re-stamps a name that is removed and then restored', () => {
		const gone = foldImportChange('import numpy as np', '', {}, 100);
		expect(stamps(gone)).toEqual({ np: 100 });
		const back = foldImportChange('', 'import numpy as np', gone, NOW);
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

	it('keeps an ordinary code cell out of the map entirely', () => {
		// Never imports-only ⇒ nothing knowable, nothing stored: the map stays empty so
		// no stamp rides every cell:edited event or checkpoint snapshot for a cell that
		// binds no imports at all.
		expect(foldImportChange('df = load()', 'df = load()\ndf.head()', undefined, NOW)).toEqual({});
	});
});
