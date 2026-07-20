# Third-party notices

Cellar's dependencies are declared in `package.json` and carry their own license
notices under `node_modules/`. This file covers something those don't: code and
palettes that were **copied into this repository verbatim** (rather than consumed
as a dependency). Both the MIT and BSD-2-Clause licenses require preserving the
original copyright and permission notices when their material is redistributed
this way, which is what this file does.

---

## One Dark (editor + export dark syntax palette)

- **Project:** [`@codemirror/theme-one-dark`](https://github.com/codemirror/theme-one-dark)
  (itself a port of the [Atom](https://github.com/atom/atom) "One Dark" theme,
  © GitHub, Inc.).
- **Author / copyright:** © Marijn Haverbeke and the CodeMirror contributors.
- **License:** MIT.
- **What Cellar uses it for:** the **dark** editor syntax palette. The colors were
  ported in verbatim as CSS custom properties (`--cellar-cm-*` in
  [`src/app.css`](src/app.css), consumed by the single static theme in
  [`src/lib/editorTheme.ts`](src/lib/editorTheme.ts)) so a theme toggle repaints
  instead of reconfiguring every mounted editor. The same dark palette is reused
  verbatim by the self-contained HTML export
  ([`src/lib/server/export-html.ts`](src/lib/server/export-html.ts)). The npm
  dependency was removed once the values lived in-repo.

```
MIT License

Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## One Light (editor light syntax palette)

- **Project:** the [Atom](https://github.com/atom/atom) "One Light" theme - the
  light sibling of One Dark.
- **Author / copyright:** © GitHub, Inc. and Atom contributors.
- **License:** MIT.
- **What Cellar uses it for:** the **light** editor syntax palette (the
  `--cellar-cm-*` light values in [`src/app.css`](src/app.css), consumed by
  [`src/lib/editorTheme.ts`](src/lib/editorTheme.ts)). The palette was ported in
  and retuned so every token clears WCAG AA on Cellar's light editor surface,
  chosen as the deliberate light-mode sibling of the dark One Dark theme.

```
MIT License

Copyright (c) 2011-2022 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## Pygments "default" style (HTML export light syntax palette)

- **Project:** [Pygments](https://pygments.org/), the `default` style.
- **Author / copyright:** © the Pygments team (Georg Brandl and contributors).
- **License:** BSD 2-Clause.
- **What Cellar uses it for:** the **light** syntax palette of the self-contained
  HTML export ([`src/lib/server/export-html.ts`](src/lib/server/export-html.ts)) -
  the classic Jupyter light scheme (green keywords, red strings, blue functions).
  The values were ported in verbatim; the export's dark palette is the One Dark
  entry above.

```
Copyright (c) 2006-2022 by the respective authors (see AUTHORS file).
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## A note on nbdev

Cellar's clean-on-save pipeline ([`src/lib/server/clean.ts`](src/lib/server/clean.ts))
is a **re-implementation** of nbdev v2's `clean_nb` field policy in Cellar's own
code - it follows the documented policy (null execution counts, a metadata
allowlist, memory-address scrubbing) rather than copying nbdev's source. It is
noted here for provenance; because no code was copied verbatim, no license notice
is reproduced.
