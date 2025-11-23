const AppError = require("../utils/AppError");
const path = require("path");
const fs = require("fs");
const unzipper = require("unzipper");
const archiver = require("archiver");
const knex = require("../database/knex");
const Database = require("better-sqlite3");
const { toZonedTime } = require("date-fns-tz");
const { format } = require("date-fns");

const PublicationRepository = require("../repositories/PublicationRepository");
const BackupLogsRepository = require("../repositories/BackupLogsRepository");
const PublicationsService = require("./PublicationsService");

const TypesOfPublicationRepository = require("../repositories/TypesOfPublicationRepository");

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

    // Exportação e Importação do banco de dados

    async exportDatabaseAndAttachments(filters) {
        const { domain_id, type_of_publication_id, triggerType = "Manual" } = filters;
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
            if (triggerType === "Manual") {
                await backupLogsRepository.createLog({
                    action_type: 'Exportação',
                    trigger_type: 'Manual',
                    status: 'Sucesso',
                    file_name: path.basename(zipPath),
                    file_size: fileSize,
                    message: 'Exportação concluída com sucesso.'
                });
            }

            return zipPath;

        } catch (error) {
            console.error("Erro durante exportação:", error);

            // Log de erro
            if (triggerType === "Manual") {
                await backupLogsRepository.createLog({
                    action_type: 'Exportação',
                    trigger_type: 'Manual',
                    status: 'Erro',
                    file_name: path.basename(zipPath),
                    file_size: 0,
                    message: `Erro na exportação: ${error.message}`
                });
            }

            throw new AppError("Falha ao exportar o banco de dados.", 500);
        }
    };

    async _generateSQLDump(domain_id, type_of_publication_id) {
        // TODO: Adicionar futura tabela de backup_logs
        const tables = ["types_of_publication", "domains", "users", "publications", "attachments"];

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

    async importDatabaseFromZip(file) {
        const backupLogsRepository = new BackupLogsRepository();

        const importDir = path.resolve(__dirname, "..", "..", "tmp", "import_temp");
        const uploadDir = path.resolve(__dirname, "..", "..", "tmp", "uploads");

        // Garante que o diretório temporário para importação exista
        if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });

        try {
            // Valida o tipo do arquivo
            if (!file || !file.originalname.endsWith(".zip")) {
                throw new AppError("Arquivo inválido. Envie um arquivo .zip", 400);
            }

            const zipPath = file.path;

            // Extrai o conteúdo do zip
            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: importDir }))
                .promise();

            const sqlPath = path.join(importDir, "database_export.sql");

            if (!fs.existsSync(sqlPath)) {
                throw new AppError("Arquivo SQL não encontrado no backup.", 400);
            }

            // Valida conteúdo do SQL (anti-injeção / anti-drop)
            const sqlContent = fs.readFileSync(sqlPath, "utf-8");
            const forbidden = /(drop\s+table|alter\s+table|delete\s+from\s+\w+)/gi;
            if (forbidden.test(sqlContent)) {
                throw new AppError("Arquivo SQL contém comandos perigosos.", 400);
            }

            function safeSplitSQL(sql) {
                const statements = [];
                let current = '';
                let inString = false;

                for (let i = 0; i < sql.length; i++) {
                    const char = sql[i];

                    if (char === "'") {
                        // Detecta entrada ou saída de uma string
                        const nextChar = sql[i + 1];
                    if (nextChar === "'") {
                        // Aspas duplas dentro da string ('') → pula o próximo
                        current += "''";
                        i++;
                        continue;
                    }
                    inString = !inString;
                    }

                    if (char === ';' && !inString) {
                        // Fim de uma instrução SQL válida
                        statements.push(current.trim());
                        current = '';
                    } else {
                        current += char;
                    }
                }

                if (current.trim()) statements.push(current.trim());

                return statements;
            }

            // Transação segura
            await knex.transaction(async trx => {
                const statements = safeSplitSQL(sqlContent);

                for (const statement of statements) {
                    await trx.raw(statement);
                }

                // Copia os arquivos de uploads (se houver)
                const extractedUploads = path.join(importDir, "uploads");
                    if (fs.existsSync(extractedUploads)) {
                    const files = fs.readdirSync(extractedUploads);
                    for (const fileName of files) {
                        const src = path.join(extractedUploads, fileName);
                        const dest = path.join(uploadDir, fileName);
                        fs.copyFileSync(src, dest);
                    }
                }
            });

            // Log de sucesso
            await backupLogsRepository.createLog({
                action_type: "Importação",
                trigger_type: "Manual",
                status: "Sucesso",
                file_name: file.originalname,
                file_size: file.size,
                message: "Importação concluída com sucesso."
            });

            return { message: "Importação concluída com sucesso!" };
        } catch (error) {
            console.error("Erro durante importação:", error);

            await backupLogsRepository.createLog({
                action_type: "Importação",
                trigger_type: "Manual",
                status: "Erro",
                file_name: file?.originalname || "Arquivo Desconhecido",
                file_size: file?.size || 0,
                message: `Erro na importação: ${error.message}`
            });

            throw new AppError("Falha ao importar o banco de dados.", 500);
        } finally {
            // Limpeza de arquivos temporários
            if (fs.existsSync(importDir)) fs.rmSync(importDir, { recursive: true, force: true });
            if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
    };

    async generatePreview(importDir, sqlPath) {
        const sqlContent = fs.readFileSync(sqlPath, "utf-8");

        // Caminho do banco temporário
        const dbPath = path.join(importDir, "temp.db");

        // Cria um banco 
        const db = new Database(dbPath);

        try {
            db.exec("PRAGMA journal_mode = OFF;");
            db.exec("PRAGMA synchronous = OFF;");

            // Excecuta o SQL exportado
            db.exec(sqlContent);

            // --- Buscar domínios e contagem de publicações
            const domains = db
                .prepare(`
                    SELECT d.id, d.domain_name AS name, COUNT(p.id) AS publication_records
                    FROM domains d
                    LEFT JOIN publications p ON p.domain_id = d.id
                    GROUP BY d.id
                `)
                .all();

            // --- Buscar tipos e contagem de publicações
            const types = db
                .prepare(`
                SELECT t.id, t.name, COUNT(p.id) AS publication_records
                FROM types_of_publication t
                LEFT JOIN publications p ON p.type_of_publication_id = t.id
                GROUP BY t.id
                `)
                .all();

            // --- Outras contagens gerais
            const totalPublications = db.prepare("SELECT COUNT(*) AS total FROM publications").get().total;
            const totalUsers = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;

            return {
                domains,
                types_of_publication: types,
                total_publications: totalPublications,
                users: totalUsers
            };
        } catch (error) {
            console.error("Erro ao gerar preview:", error);
            throw new Error("Falha ao gerar preview do backup.");
        } finally {
            db.close();
            if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        }
    };
    
    // Backup automático

    async systemSettingUpdate({ key, value }) {
        const setting = await this.domainRepository.findSettingByKey({ key });

        if(!setting) {
            throw new AppError("Variável de configuração não encontrada.", 404);
        };

        setting.value = value ?? setting.value;
        
        const updateAt = new Date();
        const zonedDate = toZonedTime(updateAt, "UTC");
        setting.updated_at = format(zonedDate, "yyyy-MM-dd HH:mm:ss", { timeZone: "UTC" });

        const settingUpdated = await this.domainRepository.updateSystemSetting(setting);

        return settingUpdated;
    };

}

module.exports = DomainsService;