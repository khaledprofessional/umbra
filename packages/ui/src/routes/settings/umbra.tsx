import React from 'react'

import {Button} from '@/components/ui/button'

// <umbra>
// The custom layer ships its own self-contained console at /umbra. Embedding it
// here keeps the official Settings shell, deep links, and command palette while
// avoiding a second React build with its own dependency tree. The console never
// renders privileged data before the umbrelOS session is verified by umbreld.
export function UmbraSettings({page, title, description}: {page: string; title: string; description: string}) {
	const source = `/umbra/#/${page}`
	return (
		<div className='flex h-full min-h-0 flex-col gap-4'>
			<div className='flex flex-wrap items-start gap-3'>
				<div className='min-w-0 flex-1'>
					<h2 className='text-21 font-semibold -tracking-2'>{title}</h2>
					<p className='mt-1 text-13 leading-tight text-white/50'>{description}</p>
				</div>
				<Button size='sm' onClick={() => window.open(source, '_blank', 'noopener,noreferrer')}>
					Open full screen
				</Button>
			</div>
			<iframe
				title={title}
				src={source}
				className='min-h-[62vh] w-full flex-1 rounded-14 border border-white/10 bg-black/20'
				// Same-origin is required for the session cookie and API calls.
				// The console sets its own strict CSP and never loads third-party code.
				sandbox='allow-scripts allow-same-origin allow-forms allow-downloads allow-popups'
			/>
		</div>
	)
}
// </umbra>
