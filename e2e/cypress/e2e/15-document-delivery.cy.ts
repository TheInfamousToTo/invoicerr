// Run after the workflow specs, which create the documents used here.
describe('Document delivery after security dependency updates', () => {
    beforeEach(() => cy.login());

    for (const collection of ['quotes', 'invoices', 'payments']) {
        it(`downloads a valid ${collection} PDF`, () => {
            cy.request(`/api/${collection}`).then(({ body }) => {
                expect(body[collection], `${collection} fixtures`).to.have.length.greaterThan(0);
                const id = body[collection][0].id;
                cy.request({ url: `/api/${collection}/${id}/pdf`, encoding: 'binary', timeout: 60000 })
                    .then(({ headers, body: pdf }) => {
                        expect(headers['content-type']).to.include('application/pdf');
                        expect(pdf.slice(0, 5)).to.eq('%PDF-');
                        expect(pdf.length).to.be.greaterThan(1000);
                    });
            });
        });
    }

    for (const collection of ['invoices', 'payments']) {
        it(`sends ${collection} email with a valid PDF attachment`, () => {
            cy.clearEmails();
            cy.request(`/api/${collection}`).then(({ body }) => {
                expect(body[collection], `${collection} fixtures`).to.have.length.greaterThan(0);
                cy.request({
                    method: 'POST', url: `/api/${collection}/send`,
                    body: { id: body[collection][0].id }, timeout: 60000,
                }).its('status').should('be.oneOf', [200, 201]);
            });
            cy.getLastEmail().then(message => {
                expect(message.Attachments).to.have.length(1);
                const attachment = message.Attachments[0];
                expect(attachment.ContentType).to.eq('application/pdf');
                expect(attachment.Size).to.be.greaterThan(1000);
                cy.request({
                    url: `http://localhost:8025/api/v1/message/${message.ID}/part/${attachment.PartID}`,
                    encoding: 'binary',
                }).its('body').then(pdf => expect(pdf.slice(0, 5)).to.eq('%PDF-'));
            });
        });
    }
});
