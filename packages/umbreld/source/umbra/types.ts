/**
 * Structural interfaces for the Umbra layer.
 *
 * Umbra deliberately does not import `Umbreld` or Express types. The custom
 * layer must compile and unit-test on its own, and it must keep working when
 * upstream refactors its internal types. Everything here is the *minimum*
 * surface Umbra touches, expressed structurally so the real umbreld instance
 * satisfies it without casts at every call site.
 */

export type Principal = {
	sessionId: string
	accountId: string
	actor: 'account' | 'system'
}

export type LoggerLike = {
	log: (...args: any[]) => void
	error: (...args: any[]) => void
	verbose?: (...args: any[]) => void
	debug?: (...args: any[]) => void
	warn?: (...args: any[]) => void
	createChildLogger?: (name: string) => LoggerLike
}

export type AppManifest = {
	id?: string
	name?: string
	version?: string
	category?: string
	[key: string]: unknown
}

export type AppLike = {
	id: string
	dataDirectory: string
	state?: string
	readManifest: () => Promise<AppManifest>
	readCompose?: () => Promise<unknown>
	start?: () => Promise<unknown>
	stop?: () => Promise<unknown>
	restart?: () => Promise<unknown>
	update?: () => Promise<unknown>
}

export type AppsLike = {
	instances: AppLike[]
	isInstalled: (appId: string) => Promise<boolean>
	getApp: (appId: string) => AppLike
	install: (appId: string, options?: Record<string, unknown>) => Promise<unknown>
	uninstall: (appId: string) => Promise<unknown>
	update: (appId: string) => Promise<unknown>
	listMemberShares: () => Promise<{appId: string; sharedWith: 'all' | string[]}[]>
	addMemberShare: (appId: string, sharedWith: 'all' | string[]) => Promise<unknown>
	sharedAppIdsForUser: (userId: string) => Promise<string[]>
}

export type AuthLike = {
	authenticate: (token: string, audience: any) => Promise<Principal>
	validatePrincipal?: (principal: Principal) => Promise<unknown>
}

export type EventBusLike = {
	on: (event: any, listener: (data: any) => void) => any
	emit: (event: any, data?: any) => Promise<any> | any
}

export type StoreLike = {
	get: (path: any) => Promise<any>
	set: (...args: any[]) => Promise<any>
}

export type UmbrelLike = {
	dataDirectory: string
	version: string
	port: number
	logger: LoggerLike
	store: StoreLike
	apps: AppsLike
	auth: AuthLike
	server: {app?: unknown}
	eventBus: EventBusLike
	user?: {
		get?: () => Promise<{name?: string}>
		getMember?: (id: string) => Promise<{name?: string} | undefined>
		listMembers?: () => Promise<{id: string; name: string}[]>
		createUser?: (name: string, password: string) => Promise<unknown>
	}
	files?: {
		normalizeVirtualPath?: (path: string) => string
		virtualToSystemPath?: (path: string, userId: string) => Promise<string>
	}
	notifications?: {
		add?: (notification: any) => Promise<any>
	}
	update?: {
		checkUpdate?: () => Promise<unknown>
		install?: () => Promise<unknown>
	}
	mcp?: {
		listTokens?: () => Promise<unknown[]>
		getPermissions?: () => Promise<unknown>
		describeAgent?: (token: string) => Promise<unknown>
	}
}

/* -------------------------------------------------------------------------- */
/* Minimal HTTP types                                                          */
/* -------------------------------------------------------------------------- */

export type HttpRequest = {
	method?: string
	url?: string
	originalUrl?: string
	path?: string
	headers: Record<string, string | string[] | undefined>
	socket?: {remoteAddress?: string}
	ip?: string
	secure?: boolean
	cookies?: Record<string, string>
	body?: unknown
	umbra?: RequestContext
}

export type HttpResponse = {
	statusCode: number
	headersSent?: boolean
	setHeader: (name: string, value: string | string[]) => void
	getHeader?: (name: string) => string | undefined
	removeHeader?: (name: string) => void
	writeHead: (status: number, headers?: Record<string, string | string[]>) => unknown
	write: (chunk: string | Buffer) => boolean
	end: (chunk?: string | Buffer) => unknown
	on?: (event: string, listener: (...args: unknown[]) => void) => unknown
	locals?: Record<string, unknown>
}

export type RequestContext = {
	realIp: string
	viaCloudflare: boolean
	publicRequest: boolean
	principal?: Principal | null
	csrfToken?: string
	startedAt: number
}

export type NextFunction = (error?: unknown) => void

export type Middleware = (request: HttpRequest, response: HttpResponse, next: NextFunction) => void

export type Timer = ReturnType<typeof setTimeout>
