const AppError = require("../utils/AppError");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const knex = require("../database/knex");

const PublicationRepository = require("../repositories/PublicationRepository");
const BackupLogsRepository = require("../repositories/BackupLogsRepository");
const PublicationsService = require("./PublicationsService");

const TypesOfPublicationRepository = require("../repositories/TypesOfPublicationRepository");
const TypesOfPublicationsService = require("./TypesOfPublicationService");
const { type } = require("os");

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

    async exportDatabaseAndAttachments(filters) {
        const { domain_id, type_of_publication_id } = filters;
        const backupLogsRepository = new BackupLogsRepository();

        if(domain_id) {
            const domain = await this.domainRepository.findById(domain_id);
            if (!domain) throw new AppError("Domínio não encontrado.", 404);
        }
        
        if(type_of_publication_id) {
            const typesOfPublicationRepository = new TypesOfPublicationRepository();
    
            const typeOfPublication = await typesOfPublicationRepository.findById(type_of_publication_id);
            if (!typeOfPublication) throw new AppError("Tipo de publicação não encontrado.", 404);
        }

        const exportPath = path.resolve(__dirname, "..", "database", `export_temp.sql`);
        const zipPath = path.resolve(__dirname, "..", "..", "tmp", `export_${Date.now()}.zip`);
        const uploadPath = path.resolve(__dirname, "..", "..", "tmp", "uploads");

        try {
            // Gera o dump SQL (pode lançar erro)
            const sqlContent = await this._generateSQLDump(domain_id, type_of_publication_id);
            fs.writeFileSync(exportPath, sqlContent);

            // Cria o ZIP
            await new Promise(async (resolve, reject) => {
                const output = fs.createWriteStream(zipPath);
                const archive = archiver("zip", { zlib: { level: 9 } });

                output.on("close", resolve);
                archive.on("error", reject);

                archive.pipe(output);
                archive.file(exportPath, { name: `database_export.sql` });

                let attachmentsQuery = knex('attachments')
                    .select('attachments.attachment', 'attachments.id', 'attachments.publication_id', 'attachments.domain_id')
                    .leftJoin('publications', 'attachments.publication_id', 'publications.id');

                if (domain_id) attachmentsQuery = attachmentsQuery.where('attachments.domain_id', domain_id);
                if (type_of_publication_id) attachmentsQuery = attachmentsQuery.where('publications.type_of_publication_id', type_of_publication_id);

                const attachments = await attachmentsQuery;

                if (attachments.length > 0) {
                    for (const { attachment } of attachments) {
                        const filePath = path.join(uploadPath, attachment);
                        if (fs.existsSync(filePath)) {
                            archive.file(filePath, { name: `uploads/${attachment}` });
                        } else {
                            console.warn(`Arquivo não encontrado: ${attachment}`);
                        }
                    }
                } else {
                    console.warn('Nenhum anexo encontrado para os filtros aplicados.');
                }

                await archive.finalize();
            });

            // Remove o .sql temporário
            if (fs.existsSync(exportPath)) fs.unlinkSync(exportPath);

            // Pega o tamanho do arquivo final
            const stats = fs.statSync(zipPath);
            const fileSize = stats.size;

            // Log de sucesso
            await backupLogsRepository.createLog({
            action_type: 'export',
            trigger_type: 'manual',
            status: 'success',
            file_name: path.basename(zipPath),
            file_size: fileSize,
            message: 'Exportação concluída com sucesso.'
            });

            return zipPath;

        } catch (error) {
            console.error("Erro durante exportação:", error);

            // Log de erro
            await backupLogsRepository.createLog({
            action_type: 'export',
            trigger_type: 'manual',
            status: 'error',
            file_name: path.basename(zipPath),
            file_size: 0,
            message: `Erro na exportação: ${error.message}`
            });

            throw new AppError("Falha ao exportar o banco de dados.", 500);
        }
    }

    async _generateSQLDump(domain_id, type_of_publication_id) {
        // TODO: Adicionar futura tabela de backup_logs
        const tables = ["users", "attachments", "publications", "types_of_publication", "domains"];

        const createTableStatements = async (tableName) => {
            const tableInfo = await knex.raw(`PRAGMA table_info(${tableName})`);
            if (!tableInfo || tableInfo.length === 0) {
                console.warn(`⚠️ Tabela ${tableName} não encontrada no banco.`);
                return `-- Tabela ${tableName} não encontrada.\n`;
            }

            const columns = tableInfo
                .map(column => {
                const name = column.name;
                const type = column.type;
                const notnull = column.notnull ? "NOT NULL" : "";
                const dflt_value = column.dflt_value ? `DEFAULT ${column.dflt_value}` : "";
                const pk = column.pk ? "PRIMARY KEY" : "";
                return `${name} ${type} ${notnull} ${dflt_value} ${pk}`.trim();
                })
                .join(", ");

            return `CREATE TABLE IF NOT EXISTS ${tableName} (${columns});\n`;
        };

        const createInsertStatements = async (tableName, rows) => {
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

        let sqlContent = "-- Exportação de dados\n\n";

        for (const table of tables) {
            sqlContent += await createTableStatements(table) + "\n";

            let rows = [];

            if(table === "users") {
                if (domain_id) {
                    rows = await knex("users").where({ domain_id });
                } else {
                    rows = await knex("users");
                }
            }

            else if (table === "attachments") {
                // Caso com joins lógicos
                let query = knex("attachments");

                if (domain_id) query = query.where("attachments.domain_id", domain_id);

                if (type_of_publication_id) {
                    // Busca publicações com o type_of_publication_id informado
                    const pubs = await knex("publications")
                        .select("id")
                        .where({ type_of_publication_id });
                    const pubIds = pubs.map(p => p.id);
                    if (pubIds.length > 0) query = query.whereIn("attachments.publication_id", pubIds);
                    else query = query.whereRaw("1=0"); // Nenhum resultado
                }

                rows = await query;
            }

            else if (table === "publications") {
                let query = knex("publications");
                if (domain_id) query = query.where({ domain_id });
                if (type_of_publication_id) query = query.where("type_of_publication_id", type_of_publication_id);
                rows = await query;
            }

            else if (table === "types_of_publication") {
                if (type_of_publication_id) {
                    rows = await knex("types_of_publication").where("id", type_of_publication_id);
                } else {
                    rows = await knex("types_of_publication");
                }
            }

            else if (table === "domains") {
                if (domain_id) {
                    rows = await knex("domains").where("id", domain_id);
                } else {
                    rows = await knex("domains");
                }
            }

            else {
                // Tabelas sem relação direta
                rows = await knex(table);
            }

            sqlContent += await createInsertStatements(table, rows);
            sqlContent += "\n";

        }

        return sqlContent;
    };
}

module.exports = DomainsService;