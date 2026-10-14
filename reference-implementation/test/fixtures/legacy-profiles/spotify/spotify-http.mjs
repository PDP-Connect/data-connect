// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Constructed Spotify Web API responses (no recorded capture exists). Shapes follow what
// connectors/spotify/index.ts reads; one page each, `next: null`.
const track = (id, name, artist, album) => ({
	id,
	name,
	artists: [{ name: artist }],
	album: { name: album },
	duration_ms: 200000,
	popularity: 50,
	external_ids: { isrc: `USRC1${id.replace(/\D/g, "").padStart(7, "0")}` },
});
const artist = (id, name, popularity) => ({
	id,
	name,
	genres: ["indie"],
	popularity,
	followers: { total: 1000 + popularity },
});

export default function handle({ url }) {
	if (url.host !== "api.spotify.com") {
		return null;
	}
	const page = (items) => ({
		status: 200,
		body: { items, total: items.length, next: null, limit: 50, offset: 0 },
	});
	switch (url.pathname) {
		case "/v1/me/playlists":
			return page([
				{
					id: "pl1",
					name: "Road trip",
					owner: { id: "u1", display_name: "Test User" },
					public: false,
					collaborative: false,
					tracks: { total: 12 },
					snapshot_id: "snap1",
					description: "Songs",
				},
				{
					id: "pl2",
					name: "Focus",
					owner: { id: "u1", display_name: "Test User" },
					public: true,
					collaborative: false,
					tracks: { total: 3 },
					snapshot_id: "snap2",
					description: null,
				},
			]);
		case "/v1/me/tracks":
			return page([
				{
					added_at: "2026-09-01T10:00:00Z",
					track: track("trk000001", "Song One", "Artist A", "Album X"),
				},
				{
					added_at: "2026-09-02T10:00:00Z",
					track: track("trk000002", "Song Two", "Artist B", "Album Y"),
				},
			]);
		case "/v1/me/top/artists": {
			const range = url.searchParams.get("time_range");
			const bump = { short_term: 1, medium_term: 2, long_term: 3 }[range] ?? 0;
			return page([
				artist(`art${bump}001`, `Artist ${bump}A`, 60 + bump),
				artist(`art${bump}002`, `Artist ${bump}B`, 40 + bump),
			]);
		}
		case "/v1/me/player/recently-played":
			return page([
				{
					played_at: "2026-10-10T12:00:00.000Z",
					track: track("trk000001", "Song One", "Artist A", "Album X"),
					context: { type: "playlist" },
				},
				{
					played_at: "2026-10-10T12:05:00.000Z",
					track: track("trk000002", "Song Two", "Artist B", "Album Y"),
					context: null,
				},
			]);
		default:
			return null;
	}
}
