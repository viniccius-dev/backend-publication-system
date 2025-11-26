const fs = require("fs");
const path = require("path");
const unzipper = require("unzipper");

const AppError = require("../utils/AppError");

const DomainRepository = require("../repositories/DomainRepository");
const BackupLogsRepository = require("../repositories/BackupLogsRepository");
const DomainsService = require("../services/DomainsService");

class DomainsController {
    async create(request, response) {
        const { domain_name, url } = request.body;

        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);
        await domainsService.domainCreate({ domain_name, url });

        return response.status(201).json({ message: "Domínio cadastrado com sucesso." });
    };

    async update(request, response) {
        const { domain_name, url } = request.body;
        const { domain_id } = request.params;

        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);
        await domainsService.domainUpdate({ domain_name, url, domain_id });

        return response.json({ message: "Informações de domínio atualizadas com sucesso." });
    };

    async delete(request, response) {
        const { domain_id } = request.params;

        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);
        await domainsService.domainDelete(domain_id);

        return response.json({ message: "Domínio deletado com sucesso." });
    };

    async index(request, response) {
        const domainRepository = new DomainRepository();
        const domains = await domainRepository.getDomains();

        return response.json(domains);
    };

    async show(request, response) {
        const { domain_id } = request.params;

        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);
        const domain = await domainsService.showDomain(domain_id);

        return response.json(domain);
    };

    async exportDatabaseAndAttachments(request, response) {
        const { domain_id, type_of_publication_id } = request.query;

        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);

        try {
            const zipPath = await domainsService.exportDatabaseAndAttachments({
                domain_id,
                type_of_publication_id
            });

            response.download(zipPath, `export_${Date.now()}.zip`, (err) => {
                if (err) console.error(err);
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            });
        } catch (error) {
            console.error("Erro ao exportar os dados e arquivos anexados", error);
            response.status(500).json({ message: "Erro ao exportar os dados e arquivos anexados" });
        }
    };

    async importDatabaseAndAttachments(request, response) {
        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);

        try {
            const result = await domainsService.importDatabaseFromZip(request.file);
            return response.status(200).json(result);
        } catch (error) {
            return response.status(error.statusCode || 500).json({
                status: "error",
                message: error.message || "Erro inesperado durante importação."
            });
        }
    };

    async previewImport(request, response) {
        const file = request.file;
        const domainsService = new DomainsService();

        const importDir = path.resolve(__dirname, "..", "..", "tmp", "preview_temp");
        if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });

        try {
            if (!file || !file.originalname.endsWith(".zip")) {
                throw new AppError("Arquivo inválido. Envie um arquivo .zip", 400);
            };

            const sqlPath = path.join(importDir, "database_export.sql");

            // Extrai apenas o arquivo database_export.sql do zip
            await new Promise((resolve, reject) => {
                const zipStream = fs.createReadStream(file.path)
                .pipe(unzipper.Parse());

                let found = false;

                zipStream.on("entry", async (entry) => {
                const fileName = entry.path;

                if (fileName === "database_export.sql") {
                    found = true;
                    entry.pipe(fs.createWriteStream(sqlPath))
                    .on("finish", resolve)
                    .on("error", reject);
                } else {
                    entry.autodrain(); // Ignora os outros arquivos
                }
                });

                zipStream.on("close", () => {
                if (!found) reject(new AppError("Arquivo SQL não encontrado no backup.", 400));
                });

                zipStream.on("error", reject);
            });

            // Confirma se o arquivo SQL foi realmente extraído
            if (!fs.existsSync(sqlPath)) {
                throw new AppError("Arquivo SQL não encontrado no backup.", 400);
            }

            // Analisa o conteúdo SQL e gera preview
            const result = await domainsService.generatePreview(importDir, sqlPath);

            return response.status(200).json({
                message: "Preview gerado com sucesso",
                summary: result
            });

        } catch (error) {
            console.error("Erro ao gerar preview:", error);
            throw new AppError("Falha ao gerar preview do backup.", 500);
        } finally {
            // Limpeza de arquivos temporários
            if (fs.existsSync(importDir)) fs.rmSync(importDir, { recursive: true, force: true });
            if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        };
    };

    async indexLogsBackup(request, response) {
        const backupLogsRepository = new BackupLogsRepository();
        const backupLogs = await backupLogsRepository.getBackupLogs();

        return response.json(backupLogs);
    };

    async getExportProgress(request, response) {
        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);
        const exportProgress = await domainsService.getExportProgress();

        response.json({ progress: exportProgress })
    };

    async updateSystemSettings(request, response) {
        const { key, value } = request.body;

        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);
        await domainsService.systemSettingUpdate({ key, value });

        return response.json({ message: "Configuração de backup automático atualizado com sucesso." });
    };

    async getSystemSetting(request, response) {
        const { key } = request.params;

        const domainRepository = new DomainRepository();
        const setting = await domainRepository.findSettingByKey({ key });

        return response.json(setting);
    };
};

module.exports = DomainsController;