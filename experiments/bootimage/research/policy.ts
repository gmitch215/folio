import { createHash } from 'node:crypto';

export function normalizeHtml(html: string) {
	const formBuildIds: string[] = [];
	const normalized = html
		.replace(/(js-view-dom-id-)[0-9a-f]{64}/g, '$1')
		.replace(/("permissionsHash":")[0-9a-f]{64}/g, '$1')
		.replace(/<input\b[^>]*\bname="form_build_id"[^>]*>/g, (tag: string) => {
			const value = /\bvalue="([^"]*)"/.exec(tag)?.[1];
			if (value) formBuildIds.push(createHash('sha256').update(value).digest('hex'));
			return tag
				.replace(/\bdata-drupal-selector="[^"]*"/, 'data-drupal-selector="form-build-id"')
				.replace(/\bvalue="[^"]*"/, 'value="form-build-id"');
		});
	return { normalized, formBuildIds };
}

export function imageDecision(
	arm: string,
	context: string,
	expectedContext: string,
	modules: string,
	expectedModules: string
) {
	const eligible = context === expectedContext,
		resetEligible = modules === expectedModules;
	return {
		eligible,
		resetEligible,
		useImage:
			arm === 'unguarded' ||
			(arm === 'guarded' && eligible) ||
			(['reset', 'memory'].includes(arm) && resetEligible)
	};
}
