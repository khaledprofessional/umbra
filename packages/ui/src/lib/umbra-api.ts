// <umbra>
// Small same-origin client for the custom layer. The Umbra API requires a
// session-bound CSRF header, which is fetched once and cached for the tab.
let csrfToken: string | null = null

async function sessionToken(): Promise<string> {
	if (csrfToken) return csrfToken
	const response = await fetch('/umbra/api/session', {credentials: 'same-origin', cache: 'no-store'})
	if (!response.ok) throw new Error('Umbra session is unavailable')
	const data = (await response.json()) as {csrfToken?: string}
	if (!data.csrfToken) throw new Error('Umbra session is unavailable')
	csrfToken = data.csrfToken
	return csrfToken
}

export async function umbraApi<T = unknown>(
	path: string,
	options: {method?: string; body?: unknown} = {},
	retry = true,
): Promise<T> {
	const method = (options.method ?? 'GET').toUpperCase()
	const headers: Record<string, string> = {Accept: 'application/json'}
	if (method !== 'GET') headers['x-umbra-csrf'] = await sessionToken()
	if (options.body !== undefined) headers['Content-Type'] = 'application/json'
	const response = await fetch(`/umbra/api${path}`, {
		method,
		credentials: 'same-origin',
		cache: 'no-store',
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	})
	const text = await response.text()
	let data: Record<string, unknown> = {}
	try {
		data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
	} catch {
		data = {error: text.slice(0, 300)}
	}
	// A rotated session invalidates the cached CSRF token. Refresh it once.
	if (response.status === 403 && retry && method !== 'GET') {
		csrfToken = null
		return umbraApi<T>(path, options, false)
	}
	if (!response.ok) throw new Error(String(data.error ?? `Umbra request failed (${response.status})`))
	return data as T
}

export const UmbraApi = {
	get: <T = unknown>(path: string) => umbraApi<T>(path),
	post: <T = unknown>(path: string, body?: unknown) => umbraApi<T>(path, {method: 'POST', body}),
}

export type MemberInstallPolicy = 'none' | 'request' | 'manage'
// </umbra>
