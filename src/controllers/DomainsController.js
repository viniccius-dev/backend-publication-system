const fs = require("fs");

const DomainRepository = require("../repositories/DomainRepository");
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
    }

    // TODO: Fragmentar para DomainsService e DomainRepository
    async exportDatabaseAndAttachments(request, response) {
        const { domain_id } = request.params;

        const domainRepository = new DomainRepository();
        const domainsService = new DomainsService(domainRepository);

        try {
            const zipPath = await domainsService.exportDatabaseAndAttachments(domain_id);
            response.download(zipPath, `export_${domain_id}.zip`, (err) => {
                if (err) console.error(err);
                // Remove o arquivo ZIP após o download
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            });
        } catch (error) {
            console.error("Erro ao exportar os dados e arquivos anexados", error);
            response.status(500).json({ message: "Erro ao exportar os dados e arquivos anexados" });
        }
    };

};

module.exports = DomainsController;