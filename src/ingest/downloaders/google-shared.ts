import { HelpfulError } from "../../errors.ts";
import type { DownloaderCtx } from "./index.ts";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/**
 * Fetch a Google export URL using cookies from the persistent
 * chromium profile. Uses Node's built-in `fetch` (not Playwright's
 * APIRequestContext) because Playwright crashes when parsing
 * Set-Cookie headers on same-origin Google redirects (its
 * `_parseSetCookieHeader` calls `new URL(responseUrl)` with a
 * relative path and throws `ERR_INVALID_URL`).
 *
 * Same redirect handling rules as the Playwright path used to do:
 * follow same-origin internal redirects (Google may bounce the
 * download via `/exportInternal` or similar) but bail with a clean
 * `auth_error` if Google sends us to `accounts.google.com/ServiceLogin`
 * because the user isn't signed in.
 */
export async function fetchWithBrowserCookies(
	exportUrl: string,
	ctx: DownloaderCtx,
	serviceName: string,
	sourceUrl: URL,
): Promise<Buffer> {
	const cookieHeader = await ctx.pool.cookieHeader(exportUrl);

	let currentUrl = exportUrl;
	for (let hop = 0; hop < 5; hop++) {
		const response = await fetch(currentUrl, {
			headers: {
				Cookie: cookieHeader,
				"User-Agent": USER_AGENT,
				Accept: "*/*",
			},
			redirect: "manual",
		});

		if (response.status >= 200 && response.status < 300) {
			return Buffer.from(await response.arrayBuffer());
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new HelpfulError({
					kind: "network_error",
					message: `${serviceName} returned ${response.status} for ${sourceUrl.toString()} with no Location header.`,
					hint: "Open the URL in your browser to verify it exists and is shared with you.",
				});
			}
			const next = new URL(location, currentUrl);
			if (next.hostname === "accounts.google.com" || /\/ServiceLogin/i.test(next.pathname)) {
				throw new HelpfulError({
					kind: "auth_error",
					message: `${serviceName} redirected ${sourceUrl.toString()} to a Google login page.`,
					hint: "Run `membot login` and sign into Google in the browser that opens, then re-run.",
				});
			}
			currentUrl = next.toString();
			continue;
		}

		if (response.status === 401 || response.status === 403) {
			throw new HelpfulError({
				kind: "auth_error",
				message: `${serviceName} returned ${response.status} for ${sourceUrl.toString()}.`,
				hint: "Run `membot login` and sign into Google in the browser that opens, then re-run.",
			});
		}

		throw new HelpfulError({
			kind: "network_error",
			message: `${serviceName} returned ${response.status} ${response.statusText} for ${sourceUrl.toString()}.`,
			hint: "Open the URL in your browser to verify it's accessible to your account.",
		});
	}

	throw new HelpfulError({
		kind: "network_error",
		message: `${serviceName} bounced through too many redirects for ${sourceUrl.toString()}.`,
		hint: "Re-run the command; if the failure persists, open the URL in your browser to investigate.",
	});
}
