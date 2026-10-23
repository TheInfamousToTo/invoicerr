import { FRENCH_BUYER_IDENTIFIERS } from "../fixtures/identifiers";

/** A foreign seller's invoice to the baseline French business client names that client's VAT number. */
export function giveBaselineClientItsVat() {
	const api = Cypress.env("apiUrl");
	cy.request({ url: `${api}/api/documents/references/client/search` })
		.its("body")
		.then((clients: { id: string; label: string }[]) => {
			cy.request({
				method: "PATCH",
				url: `${api}/api/clients/${clients[0].id}`,
				body: {
					name: clients[0].label,
					identifiers: [...FRENCH_BUYER_IDENTIFIERS, { scheme: "VAT", value: "FR44732829320" }],
				},
			})
				.its("status")
				.should("be.oneOf", [200, 201]);
		});
}
