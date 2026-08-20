<script lang="ts">
	/**
	 * The sidebar CHAT section: which Claude account answers chat cells, and the
	 * controls to sign in / out / switch - Cellar's own login surface.
	 *
	 * The rules it renders are the server's (`server/chat/auth.ts`), never a
	 * second copy:
	 *
	 * - The status line shows the SAME resolution the run path uses (selected
	 *   Cellar slot if authenticated, else the ambient terminal login, else
	 *   none), fetched from `/api/chat/status`.
	 * - The ambient terminal login is BORROWED: it renders with an explanation
	 *   and deliberately NO sign-out control - Cellar may use it and may never
	 *   revoke it. Sign-out is only ever offered on a named Cellar slot, whose
	 *   credential Cellar's own sign-in minted (the Databricks-logout doctrine).
	 * - Sign-in runs `claude auth login` server-side in the slot's isolated
	 *   CLAUDE_CONFIG_DIR; this panel shows the URL to open (the server never
	 *   pops a browser) and forwards the paste-fallback code. No token or
	 *   credential ever reaches this component - identity fields only.
	 *
	 * Mounted lazily on first open (the Databricks idiom): its status read spawns
	 * `claude auth status` per slot, which a user who never opens this section
	 * should not pay for.
	 */
	import type { ChatAccountInfo, ChatAuthResolution, ChatLoginView, ChatSlotInfo } from '$lib/chatCell';
	import { isValidChatSlotName } from '$lib/chatCell';

	let { visible = true }: { visible?: boolean } = $props();

	let resolution = $state<ChatAuthResolution | null>(null);
	let slots = $state<ChatSlotInfo[]>([]);
	let loading = $state(false);
	let statusError = $state<string | null>(null);
	// Generation guard (the `statusSeq` convention): refreshes overlap (manual
	// refresh racing a login-settle refresh), and an older reply landing last
	// must not restore a stale account line.
	let seq = 0;

	// One sign-in attempt at a time. `login.running` drives a poll; a settled
	// attempt stays rendered (success or failure) until dismissed.
	let login = $state<ChatLoginView | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let addOpen = $state(false);
	let newSlotName = $state('chat');
	let code = $state('');
	let copied = $state(false);
	// Sign-out is destructive (revokes that slot's sign-in), so it arms first
	// (the Checkpoints restore idiom). Holds the armed slot's name.
	let confirmSignOut = $state<string | null>(null);
	let busy = $state<string | null>(null); // a slot op in flight ('use:x'/'out:x'/...)

	export async function refresh(fresh = true): Promise<void> {
		const mySeq = ++seq;
		loading = true;
		try {
			const res = await fetch(`/api/chat/status${fresh ? '?fresh=1' : ''}`);
			if (!res.ok) throw new Error(`status ${res.status}`);
			const body = await res.json();
			if (mySeq !== seq) return;
			resolution = body.resolution ?? null;
			slots = Array.isArray(body.slots) ? body.slots : [];
			statusError = null;
		} catch (err) {
			if (mySeq !== seq) return;
			statusError = String(err);
		} finally {
			if (mySeq === seq) loading = false;
		}
	}

	// First open fetches; later opens are covered by the header refresh + the
	// login/select/sign-out flows refreshing after themselves.
	let fetched = false;
	$effect(() => {
		if (visible && !fetched) {
			fetched = true;
			void refresh(false);
		}
	});

	function stopPoll() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
	}
	// Poll a running sign-in ~every 1.2s: the URL appears moments after start,
	// and settle is when the browser round-trip completes. Self-arming like the
	// Databricks restart re-check; stops the moment the attempt settles.
	function armPoll() {
		stopPoll();
		if (!login?.running) return;
		pollTimer = setTimeout(async () => {
			const id = login?.id;
			if (!id) return;
			try {
				const res = await fetch(`/api/chat/login?id=${encodeURIComponent(id)}`);
				const body = res.ok ? await res.json() : null;
				if (login?.id === id && body?.login) {
					const wasRunning = login.running;
					const next = body.login as ChatLoginView;
					login = next;
					if (wasRunning && !next.running) void refresh(true);
				}
			} catch {
				// transient; the next tick retries
			}
			armPoll();
		}, 1200);
		if (typeof pollTimer.unref === 'function') pollTimer.unref?.();
	}
	$effect(() => {
		if (login?.running) armPoll();
		else stopPoll();
		return stopPoll;
	});

	const newSlotOk = $derived(isValidChatSlotName(newSlotName.trim()));

	async function startLogin() {
		const slot = newSlotName.trim();
		if (!isValidChatSlotName(slot)) return;
		busy = 'login';
		code = '';
		copied = false;
		try {
			const res = await fetch('/api/chat/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'start', slot })
			});
			const body = await res.json();
			if (res.ok && body?.login) login = body.login;
			else statusError = body?.reason ?? 'sign-in failed to start';
		} catch (err) {
			statusError = String(err);
		} finally {
			busy = null;
		}
	}

	async function submitCode() {
		if (!login || !code.trim()) return;
		const id = login.id;
		try {
			await fetch('/api/chat/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'code', id, code })
			});
			code = '';
		} catch {
			// the poll surfaces the outcome either way
		}
	}

	async function cancelLogin() {
		if (!login) return;
		const id = login.id;
		try {
			await fetch('/api/chat/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'cancel', id })
			});
		} catch {
			// best-effort; dismiss regardless
		}
		login = null;
		void refresh(true);
	}

	function dismissLogin() {
		login = null;
	}

	async function copyLoginUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// denied: the link itself is still clickable
		}
	}

	async function useSlot(slot: string | null) {
		busy = `use:${slot ?? ''}`;
		confirmSignOut = null;
		try {
			await fetch('/api/chat/slots', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ slot })
			});
			await refresh(false);
		} finally {
			busy = null;
		}
	}

	async function signOut(slot: string) {
		busy = `out:${slot}`;
		confirmSignOut = null;
		try {
			const res = await fetch('/api/chat/logout', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ slot })
			});
			const body = await res.json();
			if (!body?.ok) statusError = body?.error ?? 'sign-out did not complete';
			await refresh(true);
		} finally {
			busy = null;
		}
	}

	function accountLabel(account: ChatAccountInfo | null | undefined): string {
		if (!account?.loggedIn) return 'signed out';
		const who = account.email || account.orgName || 'signed in';
		return account.subscriptionType ? `${who} · ${account.subscriptionType}` : who;
	}

	// The ambient option is offered whenever a slot is selected (switch back) or
	// nothing at all resolves - it costs nothing and states the borrow rule.
	const usingAmbient = $derived(resolution != null && resolution.kind !== 'slot' && slots.every((s) => !s.selected));
</script>

<div class="space-y-2 px-3 pb-3" data-testid="chat-body">
	{#if statusError}
		<div class="rounded-lg border border-error/30 bg-error/10 p-2 text-[11px] leading-relaxed" data-testid="chat-error">
			{statusError}
		</div>
	{/if}

	<!-- Who answers chat cells right now: the run path's own resolution. -->
	<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="chat-account-card">
		<div class="mb-1 text-[10px] font-semibold tracking-wider text-base-content/45 uppercase">Chat account</div>
		{#if !resolution}
			<div class="text-[11px] text-base-content/50">{loading ? 'Checking…' : 'Unknown'}</div>
		{:else if resolution.notInstalled}
			<div class="text-[11px] leading-relaxed" data-testid="chat-status-line">
				<span class="mr-1 inline-block h-2 w-2 rounded-full bg-base-content/30"></span>
				Claude Code is not installed - chat cells need the <code class="font-mono">claude</code> CLI on PATH.
			</div>
		{:else if resolution.kind === 'slot'}
			<div class="flex items-center gap-1.5 text-[11px]" data-testid="chat-status-line">
				<span class="inline-block h-2 w-2 rounded-full bg-success"></span>
				<span class="truncate font-medium">{accountLabel(resolution.account)}</span>
			</div>
			<div class="mt-0.5 text-[10px] text-base-content/50">Cellar account · {resolution.slot}</div>
		{:else if resolution.kind === 'ambient'}
			<div class="flex items-center gap-1.5 text-[11px]" data-testid="chat-status-line">
				<span class="inline-block h-2 w-2 rounded-full bg-success"></span>
				<span class="truncate font-medium">{accountLabel(resolution.account)}</span>
			</div>
			<!-- The borrow rule, stated where the missing sign-out would be looked
			     for: this credential is the user's own terminal login, so Cellar
			     never offers to revoke it. -->
			<div class="mt-0.5 text-[10px] leading-relaxed text-base-content/50" data-testid="chat-borrowed-note">
				Borrowed from your terminal's Claude login. Cellar uses it read-only and never signs it out - sign out with
				<code class="font-mono">claude auth logout</code> if you need to. Add a Cellar account below to keep chat on its own
				login.
			</div>
		{:else}
			<div class="flex items-center gap-1.5 text-[11px]" data-testid="chat-status-line">
				<span class="inline-block h-2 w-2 rounded-full bg-base-content/30"></span>
				<span>Not signed in</span>
			</div>
			<div class="mt-0.5 text-[10px] text-base-content/50">
				Chat cells need a Claude account: add one below, or sign in to the claude CLI in a terminal.
			</div>
		{/if}
	</div>

	<!-- Named Cellar slots: use / sign out (two-step). -->
	{#if slots.length}
		<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="chat-slots-card">
			<div class="mb-1 text-[10px] font-semibold tracking-wider text-base-content/45 uppercase">Cellar accounts</div>
			<div class="space-y-1">
				{#each slots as s (s.slot)}
					<div class="rounded-md {s.selected ? 'bg-primary/10' : ''} px-1.5 py-1" data-testid="chat-slot-row" data-slot={s.slot}>
						<div class="flex items-center gap-1.5">
							<span class="inline-block h-1.5 w-1.5 rounded-full {s.account?.loggedIn ? 'bg-success' : 'bg-base-content/25'}"></span>
							<span class="min-w-0 flex-1 truncate text-[11px]">
								<span class="font-medium">{s.slot}</span>
								<span class="ml-1 text-base-content/50">{accountLabel(s.account)}</span>
							</span>
							{#if !s.selected}
								<button
									class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[10px]"
									onclick={() => useSlot(s.slot)}
									disabled={busy != null}
									data-testid="chat-slot-use">Use</button
								>
							{:else}
								<span class="text-[9px] font-semibold tracking-wide text-primary/80 uppercase">selected</span>
							{/if}
							{#if s.account?.loggedIn}
								<button
									class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[10px] text-base-content/50"
									onclick={() => (confirmSignOut = confirmSignOut === s.slot ? null : s.slot)}
									disabled={busy != null}
									title="Sign this Cellar account out (your terminal's Claude login is never touched)"
									data-testid="chat-slot-signout">Sign out</button
								>
							{/if}
						</div>
						{#if confirmSignOut === s.slot}
							<div class="mt-1 rounded-md border border-warning/30 bg-warning/10 p-1.5 text-[10px] leading-relaxed" data-testid="chat-signout-confirm-box">
								Signs the <span class="font-medium">{s.slot}</span> account out of Claude (its sign-in is revoked). Your
								terminal's own Claude login is not affected.
								<div class="mt-1 flex gap-1">
									<button class="btn btn-warning btn-xs h-5 min-h-0 px-2 text-[10px]" onclick={() => signOut(s.slot)} data-testid="chat-signout-confirm">
										Sign out
									</button>
									<button class="btn btn-ghost btn-xs h-5 min-h-0 px-2 text-[10px]" onclick={() => (confirmSignOut = null)} data-testid="chat-signout-cancel">
										Cancel
									</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}
				{#if !usingAmbient && slots.some((s) => s.selected)}
					<button
						class="btn btn-ghost btn-xs h-5 min-h-0 w-full justify-start px-1.5 text-[10px] text-base-content/60"
						onclick={() => useSlot(null)}
						disabled={busy != null}
						title="Stop using a Cellar account; chat borrows your terminal's Claude login (read-only) when one exists"
						data-testid="chat-use-ambient">Use terminal login instead</button
					>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Add a Cellar account: named slot -> browser sign-in (server-run, isolated). -->
	<div class="rounded-lg border border-base-300 bg-base-100 p-2.5" data-testid="chat-add-card">
		{#if login}
			<div class="mb-1 text-[10px] font-semibold tracking-wider text-base-content/45 uppercase">
				Sign in · {login.slot}
			</div>
			{#if login.running}
				{#if login.browserUrl || login.pasteUrl}
					{@const url = login.browserUrl ?? login.pasteUrl}
					<div class="text-[11px] leading-relaxed">
						<a class="link link-primary break-all" href={url} target="_blank" rel="noreferrer noopener" data-testid="chat-login-url">
							Open the Claude sign-in page
						</a>
						<button class="btn btn-ghost btn-xs ml-1 h-5 min-h-0 px-1.5 text-[10px]" onclick={() => copyLoginUrl(url ?? '')} data-testid="chat-login-copy">
							{copied ? 'Copied' : 'Copy link'}
						</button>
					</div>
					<div class="mt-1 text-[10px] leading-relaxed text-base-content/50">
						Finish in the browser and this completes by itself. If the page shows a code instead, paste it here:
					</div>
					<div class="mt-1 flex gap-1">
						<input
							class="input input-xs h-6 min-w-0 flex-1 border-base-300 bg-base-100 font-mono text-[10px]"
							placeholder="authorization code"
							bind:value={code}
							onkeydown={(e) => e.key === 'Enter' && submitCode()}
							data-testid="chat-login-code"
						/>
						<button class="btn btn-primary btn-xs h-6 min-h-0 px-2 text-[10px]" onclick={submitCode} disabled={!code.trim()} data-testid="chat-login-code-submit">
							Submit
						</button>
					</div>
				{:else}
					<div class="text-[11px] text-base-content/60"><span class="loading loading-spinner loading-xs mr-1"></span>Starting sign-in…</div>
				{/if}
				<button class="btn btn-ghost btn-xs mt-1.5 h-5 min-h-0 px-1.5 text-[10px] text-base-content/50" onclick={cancelLogin} data-testid="chat-login-cancel">
					Cancel
				</button>
			{:else if login.ok}
				<div class="text-[11px] text-success" data-testid="chat-login-done">
					Signed in{login.account?.email ? ` as ${login.account.email}` : ''}.
				</div>
				<button class="btn btn-ghost btn-xs mt-1 h-5 min-h-0 px-1.5 text-[10px]" onclick={dismissLogin} data-testid="chat-login-dismiss">Done</button>
			{:else}
				<div class="text-[11px] leading-relaxed text-error" data-testid="chat-login-failed">
					Sign-in did not complete{login.error ? `: ${login.error}` : '.'}
				</div>
				<div class="mt-1 flex gap-1">
					<button class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[10px]" onclick={startLogin} data-testid="chat-login-retry">Try again</button>
					<button class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[10px] text-base-content/50" onclick={dismissLogin}>Dismiss</button>
				</div>
			{/if}
		{:else if addOpen}
			<div class="mb-1 text-[10px] font-semibold tracking-wider text-base-content/45 uppercase">Add account</div>
			<div class="flex gap-1">
				<input
					class="input input-xs h-6 min-w-0 flex-1 border-base-300 bg-base-100 text-[11px]"
					placeholder="account name (e.g. chat)"
					bind:value={newSlotName}
					onkeydown={(e) => e.key === 'Enter' && newSlotOk && startLogin()}
					data-testid="chat-slot-name"
				/>
				<button class="btn btn-primary btn-xs h-6 min-h-0 px-2 text-[10px]" onclick={startLogin} disabled={!newSlotOk || busy != null} data-testid="chat-login-start">
					Sign in
				</button>
			</div>
			<div class="mt-1 text-[10px] leading-relaxed text-base-content/50">
				Opens Claude's browser sign-in for a Cellar-owned account, kept fully separate from your terminal's Claude login.
			</div>
		{:else}
			<button class="btn btn-ghost btn-xs h-6 min-h-0 w-full justify-start px-1.5 text-[11px]" onclick={() => (addOpen = true)} data-testid="chat-add-account">
				+ Add a Claude account for chat
			</button>
		{/if}
	</div>
</div>
