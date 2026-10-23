import { FRENCH_BUYER_IDENTIFIERS } from "../fixtures/identifiers";

/** The French business client `resetAndSeed` creates, found by name rather than by list position. */
export function baselineClient() {
	return cy
		.request({ url: `${Cypress.env("apiUrl")}/api/documents/references/client/search?q=Test%20Client` })
		.its("body")
		.then((clients: { id: string; label: string }[]) => {
			const client = clients.find((candidate) => candidate.label === "Test Client");
			expect(client, "the baseline client exists").to.exist;
			return client!;
		});
}

/** A foreign seller's invoice to the baseline French business client names that client's VAT number. */
export function giveBaselineClientItsVat() {
	baselineClient().then((client) => {
		cy.request({
			method: "PATCH",
			url: `${Cypress.env("apiUrl")}/api/clients/${client.id}`,
			body: {
				name: client.label,
				identifiers: [...FRENCH_BUYER_IDENTIFIERS, { scheme: "VAT", value: "FR44732829320" }],
			},
		})
			.its("status")
			.should("be.oneOf", [200, 201]);
	});
}
