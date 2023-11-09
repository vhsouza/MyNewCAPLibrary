// Imports
const cds = require("@sap/cds");

module.exports = cds.service.impl(async function () {

    const { Books, BookCopies, BookAuthors, BooksText, Authors, BusinessPartners } = this.entities;

    // connect to remote service
    const BPsrv = await cds.connect.to("API_BUSINESS_PARTNER");

    this.after(['CREATE', 'UPDATE'], Books, async (req, next) => {
        await saveBookText(req, next._locale)
    });

    this.after('READ', Books, async (req, next) => {

        const BooksIds = req.map(r => r.ID)

        const booksTextDb = await readBooksTextByIds(BooksIds, next._locale)

        if (booksTextDb) {
            req.forEach((books) => {
                const bookText = booksTextDb.find(b => (b.ID == books.ID));
                if (bookText) {
                    books.Title = bookText.Title
                } else {
                    books.Title = null
                }
            })
        }

    }),

        this.after("READ", BookAuthors, async (req, next) => {

            const authors = Array.isArray(req) ? req : [req];

            authors.forEach((author) => {
                if (author.Author) {
                    author.Author.FullName = author.Author.FirstName + ' ' + author.Author.LastName
                }
            });
        });

    this.after("READ", BookCopies, async (req, next) => {

        const copies = Array.isArray(req) ? req : [req];

        copies.forEach((copy) => {
            if (copy.Status_ID == '10') {
                copy.Criticality = 3
            } else {
                copy.Criticality = 1
            }

        });
    });

    this.before("PATCH", BookCopies, async (req, next) => {

        const copiesFromDb = await readCopiesDbByKey(req.data.Book_ID, req.data.CopyID)

        const copiesAllFieldsWithChanges = getObjectNotChangedPropertiesFromDb(req.data, copiesFromDb)

        let errorObject = checkBeforeSaveBookCopies(copiesAllFieldsWithChanges)
        if (errorObject) {
            return req.error(errorObject)
        }

    });


    /**
     * Event-handler for read-events on the BusinessPartners entity.
     * Each request to the API Business Hub requires the apikey in the header.
     */
    this.on("READ", BusinessPartners, async (req) => {
        // The API Sandbox returns alot of business partners with empty names.
        // We don't want them in our application
        req.query.where("LastName <> '' and FirstName <> '' ");

        return await BPsrv.transaction(req).send({
            query: req.query,
            headers: {
                apikey: process.env.apikey,
            },
        });
    });


    this.on("READ", 'Books', async (req, next) => {

        if (!req.query.SELECT.columns) return next();
        const expandIndex = req.query.SELECT.columns.findIndex(
            ({ expand, ref }) => expand && ref[0] === "bp"
        );
        if (expandIndex < 0) return next();

        // Remove expand from query
        req.query.SELECT.columns.splice(expandIndex, 1);

        // Make sure supplier_ID will be returned
        if (!req.query.SELECT.columns.indexOf('*') >= 0 &&
            !req.query.SELECT.columns.find(
                column => column.ref && column.ref.find((ref) => ref == "bp_BusinessPartner"))
        ) {
            req.query.SELECT.columns.push({ ref: ["bp_BusinessPartner"] });
        }

        const books = await next();

        const asArray = x => Array.isArray(x) ? x : [ x ];

        // Request all associated suppliers
        const supplierIds = asArray(books).map(books => books.bp_BusinessPartner);
        const suppliers = await bupa.run(SELECT.from('RiskService.Suppliers').where({ ID: supplierIds }));

        // Convert in a map for easier lookup
        const suppliersMap = {};
        for (const supplier of suppliers)
            suppliersMap[supplier.ID] = supplier;

        // Add suppliers to result
        for (const note of asArray(risks)) {
            note.supplier = suppliersMap[note.supplier_ID];
        }

        return risks;
    });


    /***************************************************************** */
    /*INTERNAL METHODS*/
    /***************************************************************** */

    function getObjectNotChangedPropertiesFromDb(objectFromUI, objectFromDb) {

        let objectWithChanges = {}

        //When we are creating a new entry the object with more fields will be the object from UI
        let objectWithMoreFields = objectFromDb || objectFromUI

        for (let fieldName in objectWithMoreFields) {
            objectWithChanges[fieldName] = objectFromUI[fieldName] ?? objectFromDb[fieldName]
        }

        return objectWithChanges

    };

    async function readCopiesDbByKey(BookID, CopyID) {
        return cds.run(SELECT.one.from(BookCopies).columns('Book_ID', 'CopyID', 'Status_ID', 'ReservedFrom', 'ReservedUntil')
            .where('Book_ID =', BookID).
            and('CopyID =', CopyID))
    };

    async function readBooksTextByKey(BookID, Locale) {
        return await SELECT.one.from(BooksText).columns('ID', 'Title')
            .where('ID =', BookID).
            and('locale =', Locale)
    };

    async function readBooksTextByIds(BooksIds, Locale) {
        return await SELECT.from(BooksText).columns('ID', 'Title')
            .where('ID in', BooksIds).
            and('locale =', Locale)
    };

    async function saveBookText(books, Locale) {

        let bookTextExists = await readBooksTextByKey(books.ID, Locale)
        if (bookTextExists) {
            await UPDATE(Books).set({ Title: books.Title }).where({ BookID: { '=': books.ID }, Locale: { '=': Locale } })
        } else {
            await INSERT.into(BooksText).entries({ ID: books.ID, locale: Locale, Title: books.Title })
        }
    };

    function checkBeforeSaveBookCopies(copy) {

        let errorObject = getErrorObject();

        if (copy.Status_ID == '20') {

            if (copy.ReservedFrom == null) {
                errorObject.message = `Reservation From is mandatory for Status "Reserved"`;
                errorObject.target = `ReservedFrom`
                return errorObject
            }

            if (new Date(copy.ReservedFrom) < new Date()) {
                errorObject.message = `Reservation From must not be in the past`;
                errorObject.target = `ReservedFrom`
                return errorObject
            }

            if (copy.ReservedUntil == null) {
                errorObject.message = `Reservation Until is mandatory for Status "Reserved"`;
                errorObject.target = `ReservedUntil`
                return errorObject
            }

            if (copy.ReservedFrom > copy.ReservedUntil) {
                errorObject.message = `Reservation From must be lower than Reservation Until`;
                errorObject.target = `ReservedFrom`
                return errorObject
            }
        }
    }

    function getErrorObject() {
        return {
            code: 500,
            message: "",
            target: ""
        }
    }

});