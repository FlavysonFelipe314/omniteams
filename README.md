# OmniTeams

Aplicativo Atlassian Forge para relatórios operacionais e gerenciais dentro do Jira Cloud.

## Continuar o projeto em outro computador

Requisitos: Git, Node.js 22 ou superior e uma conta Atlassian adicionada como colaboradora do app Forge.

```powershell
git clone https://github.com/FlavysonFelipe314/omniteams.git
cd omniteams
npm run install:all
npx forge login
npm run build
npx forge deploy --environment development
```

O `manifest.yml` já contém o ID do aplicativo existente. **Não execute `forge register`**, pois isso vincularia o código a outro app.

O ambiente de desenvolvimento já está instalado em `inmoknill.atlassian.net`. Para instalar em um novo site de testes:

```powershell
npx forge install --environment development --site seu-site.atlassian.net --product Jira
```

## Desenvolvimento

```powershell
# Validar o projeto
npm run build
npm run lint

# Publicar em desenvolvimento
npx forge deploy --environment development

# Acompanhar logs
npx forge logs --environment development
```

Se o `manifest.yml` ganhar novos scopes, atualize a instalação depois do deploy:

```powershell
npx forge install --upgrade --environment development --site inmoknill.atlassian.net --product Jira
```

## Produção

```powershell
npm run build
npx forge deploy --environment production
```

As instalações de produção recebem o código publicado nesse ambiente. Mudanças de permissões podem exigir aprovação dos administradores dos sites.

## Recursos

- Filtros por quadro, espaço, sprint, status, período e JQL.
- Descoberta de sprints por quadro e pelos cards do projeto.
- Indicadores operacionais e visão gerencial independente da seleção lateral.
- Agrupamento de cards por colaborador ou status.
- Calendário semanal de horas com criação, edição e exclusão de worklogs.
- Comparativos, gráficos e exportação em Excel/CSV.
- Tema claro e escuro.

## Estrutura

- `manifest.yml`: módulos, runtime e permissões Forge.
- `src/resolvers/index.js`: integração com as APIs Jira e regras dos relatórios.
- `static/dashboard/src/main.jsx`: interface React.
- `static/dashboard/src/styles.css`: estilos da interface.

O app não armazena tokens no código e não utiliza banco de dados próprio. A autenticação e as permissões são controladas pelo Forge e pelo Jira.
