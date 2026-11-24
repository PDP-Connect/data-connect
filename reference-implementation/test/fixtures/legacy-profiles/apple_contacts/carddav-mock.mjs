// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A loopback CardDAV server answering the requests connectors/apple_contacts sends:
// RFC 6764 well-known discovery, principal and address-book-home PROPFINDs, an address-book
// listing, and sync-collection / addressbook-query / addressbook-multiget REPORTs. The vCards
// are constructed (no recorded iCloud capture exists). The connector reads its origin from
// APPLE_CARDDAV_ORIGIN, so this one needs no fetch shim.
import { createServer } from "node:http";

const HOME = "/carddav/u1/";
const BOOK = "/carddav/u1/card/";
const CARDS = {
	"alice.vcf":
		"BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-alice\r\nFN:Alice Example\r\nN:Example;Alice;;;\r\nEMAIL;TYPE=HOME:alice@example.test\r\nTEL;TYPE=CELL:+15550100\r\nCATEGORIES:Friends\r\nREV:2026-09-01T10:00:00Z\r\nEND:VCARD\r\n",
	"bob.vcf":
		"BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-bob\r\nFN:Bob Example\r\nN:Example;Bob;;;\r\nEMAIL:bob@example.test\r\nORG:Example Co\r\nREV:2026-09-02T10:00:00Z\r\nEND:VCARD\r\n",
	"friends.vcf":
		"BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-friends\r\nFN:Friends\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:uid-alice\r\nREV:2026-09-03T10:00:00Z\r\nEND:VCARD\r\n",
};

const esc = (text) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const multistatus = (responses) =>
	`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">${responses.join("")}</D:multistatus>`;
const response = (href, props) =>
	`<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const cardResponses = () =>
	Object.entries(CARDS).map(([name, vcard], index) =>
		response(
			`${BOOK}${name}`,
			`<D:getetag>"etag-${index}"</D:getetag><C:address-data>${esc(vcard)}</C:address-data>`,
		),
	);

export async function startCardDavMock() {
	const requests = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const path = new URL(req.url, "http://x").pathname;
			requests.push({
				method: req.method,
				path,
				authorization: req.headers.authorization ? "<present>" : null,
			});
			const send = (xml, status = 207) => {
				res.writeHead(status, {
					"content-type": "application/xml; charset=utf-8",
				});
				res.end(xml);
			};
			if (!req.headers.authorization?.startsWith("Basic ")) {
				res.writeHead(401);
				res.end();
				return;
			}
			if (
				req.method === "PROPFIND" &&
				(path === "/.well-known/carddav" || path === "/")
			) {
				send(
					multistatus([
						response(
							path,
							"<D:current-user-principal><D:href>/principals/u1/</D:href></D:current-user-principal>",
						),
					]),
				);
			} else if (req.method === "PROPFIND" && path === "/principals/u1/") {
				send(
					multistatus([
						response(
							path,
							`<C:addressbook-home-set><D:href>${HOME}</D:href></C:addressbook-home-set>`,
						),
					]),
				);
			} else if (req.method === "PROPFIND" && path === HOME) {
				send(
					multistatus([
						response(HOME, "<D:resourcetype><D:collection/></D:resourcetype>"),
						response(
							BOOK,
							"<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Card</D:displayname><CS:getctag>ctag-1</CS:getctag><D:sync-token>tok-1</D:sync-token>",
						),
					]),
				);
			} else if (req.method === "REPORT" && path === BOOK) {
				const token = body.includes("sync-collection")
					? "<D:sync-token>tok-2</D:sync-token>"
					: "";
				send(
					multistatus(cardResponses()).replace(
						"</D:multistatus>",
						`${token}</D:multistatus>`,
					),
				);
			} else {
				res.writeHead(404);
				res.end();
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
