const AppError = require("../utils/AppError");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const knex = require("../database/knex");

const PublicationRepository = require("../repositories/PublicationRepository");
const PublicationsService = require("./PublicationsService");

class DomainsService {
    constructor(domainRepository) {
        this.domainRepository = domainRepository;
    };

    async domainCreate({ domain_name, url }) {
        if(!domain_name || !url) {
            throw new AppError("Favor inserir todas as informações");
        };

        const checkDomain = await this.domainRepository.findByUrl(url);

        if(checkDomain) {
            throw new AppError("Este domínio já está cadastrado.");
        };

        const domainCreate = await this.domainRepository.create({ domain_name, url });

        return domainCreate;
    };

    async domainUpdate({ domain_name, url, domain_id }) {
        const domain = await this.domainRepository.findById(domain_id);

        if(!domain) {
            throw new AppError("Domínio não encontrado.", 404);
        };

        domain.domain_name = domain_name ?? domain.domain_name;
        domain.url = url ?? domain.url;

        const domainUpdate = await this.domainRepository.update(domain);

        return domainUpdate;
    };

    async domainDelete(domain_id) {
        const domain = await this.domainRepository.findById(domain_id);

        if(!domain) {
            throw new AppError("Domínio não encontrado", 404);
        };

        const publicationRepository = new PublicationRepository();
        const publicationsService = new PublicationsService(publicationRepository);

        const getAttachments = await publicationRepository.getAttachments({ domain_id });
        const attachmentsId = getAttachments.map(attachment => String(attachment.id));

        await publicationsService.attachmentsDelete({ domain_id, attachments: attachmentsId });

        return await this.domainRepository.delete(domain_id);
    };

    async showDomain(domain_id) {
        const domain = await this.domainRepository.findById(domain_id);

        if(!domain) {
            throw new AppError("Domínio não encontrado.", 404);
        };

        return domain;
    };

    async exportDatabaseAndAttachments(domain_id) {
        const domain = await this.domainRepository.findById(domain_id);
        if (!domain) throw new AppError("Domínio não encontrado.", 404);

        const exportPath = path.resolve(__dirname, "..", "database", `export_${domain_id}.sql`);
        const zipPath = path.resolve(__dirname, "..", "..", "tmp", `export_${domain_id}.zip`);
        const uploadPath = path.resolve(__dirname, "..", "..", "tmp", "uploads");

        // 🔹 Gera o dump SQL
        const sqlContent = await this._generateSQLDump(domain_id);
        fs.writeFileSync(exportPath, sqlContent);

        // 🔹 Cria o ZIP corretamente aguardando o fechamento
        await new Promise(async (resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", resolve);
            archive.on("error", reject);

            archive.pipe(output);

            // Adiciona o SQL ao ZIP
            archive.file(exportPath, { name: `export_${domain_id}.sql` });

            // Adiciona os anexos
            const attachments = await this.domainRepository.getAttachmentsByDomain(domain_id);
            
            if (attachments.length > 0) {
                for (const { attachment } of attachments) {
                    const filePath = path.join(uploadPath, attachment);
                    if (fs.existsSync(filePath)) {
                        archive.file(filePath, { name: `uploads/${attachment}` });
                    } else {
                        console.warn(`⚠️ Arquivo não encontrado: ${attachment}`);
                    }
                }
            } else {
                console.warn("Nenhum anexo encontrado para este domínio.");
            }

            await archive.finalize();
        });

        // Remove SQL temporário
        if (fs.existsSync(exportPath)) fs.unlinkSync(exportPath);

        return zipPath;
    }

    async _generateSQLDump(domain_id) {
        const tables = ["users", "attachments", "publications", "types_of_publication", "domains"];

        const createTableStatements = async (tableName) => {
            const tableInfo = await knex.raw(`PRAGMA table_info(${tableName})`);
            const columns = tableInfo.map(column => {
                const name = column.name;
                const type = column.type;
                const notnull = column.notnull ? "NOT NULL" : "";
                const dflt_value = column.dflt_value ? `DEFAULT ${column.dflt_value}` : "";
                const pk = column.pk ? "PRIMARY KEY" : "";
                return `${name} ${type} ${notnull} ${dflt_value} ${pk}`.trim();
            }).join(", ");
            return `CREATE TABLE ${tableName} (${columns});`;
        };

        const createInsertStatements = async (tableName, condition) => {
            const rows = condition ? await knex(tableName).where(condition) : await knex(tableName);
            const inserts = rows.map(row => {
                const columns = Object.keys(row).join(", ");
                const values = Object.values(row).map(value => {
                    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
                    if (value === null) return "NULL";
                    return value;
                }).join(", ");
                return `INSERT INTO ${tableName} (${columns}) VALUES (${values});`;
            });
            return inserts.join("\n");
        };

        let sqlContent = `-- Exportando dados para domain_id=${domain_id}\n\n`;

        for (const table of tables) {
            sqlContent += await createTableStatements(table) + "\n";
            if (table === "types_of_publication") {
                sqlContent += await createInsertStatements(table);
            } else if (table === "domains") {
                sqlContent += await createInsertStatements(table, { id: domain_id });
            } else {
                sqlContent += await createInsertStatements(table, { domain_id });
            }
            sqlContent += "\n";
        }

        return sqlContent;
    }
}

module.exports = DomainsService;