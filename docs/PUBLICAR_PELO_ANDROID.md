# Publicar no GitHub usando só o Android (Chrome)

Você vai precisar de 2 arquivos que recebeu: **`claude-trader-ai.zip`** e **`ci-cd.yml`**.
Baixe os dois no celular (ficam na pasta Downloads).

> Por que dois arquivos? O GitHub não deixa uma automação criar arquivos de automação por conta
> própria. Então você cria o `ci-cd.yml` uma vez, e ele descompacta todo o resto.

## Passo 1 — Criar a conta e o repositório
1. Abra **github.com** no Chrome e toque em **Sign up** (se ainda não tiver conta). Confirme o e-mail.
2. Toque no **+** (canto superior direito) → **New repository**.
3. Nome: `claude-trader-ai`. Marque **Private** (privado). Marque **Add a README file**.
4. Toque em **Create repository**.

## Passo 2 — Criar o arquivo de automação
1. No repositório, toque em **Add file** → **Create new file**.
2. No nome do arquivo, digite exatamente: `.github/workflows/ci-cd.yml`
   (ao digitar `/` o GitHub cria as pastas sozinho).
3. Abra o arquivo `ci-cd.yml` que você baixou, copie TODO o conteúdo e cole na caixa de texto.
4. Toque em **Commit changes…** → **Commit changes**.

## Passo 3 — Enviar o projeto
1. Volte à página inicial do repositório → **Add file** → **Upload files**.
2. Toque em **choose your files** e selecione `claude-trader-ai.zip` (não descompacte).
3. Toque em **Commit changes**.

## Passo 4 — Conferir
1. Toque na aba **Actions** (se não aparecer, use o menu ☰ ou o modo "Versão para computador" do Chrome).
2. Abra a execução mais recente de **CLAUDE TRADER AI**. Aguarde (5–10 min):
   - ✅ `descompactar` — os arquivos aparecem no repositório;
   - ✅ `testes-backend` — os testes do robô rodam, incluindo os de FastAPI;
   - ✅ `build-app` — o app é compilado com verificação completa de tipos;
   - ✅ `docker` — a imagem de produção é montada.
3. Se algo ficar ❌, tire um print da etapa vermelha e me envie.

## (Opcional) Backtest com dados REAIS
Aba **Actions** → **CLAUDE TRADER AI** → **Run workflow** → em "O que executar" escolha **backtest**,
ajuste pares, datas e capital → **Run workflow**. O relatório aparece no resumo da execução
(role a página da execução até o fim) e fica disponível para download em "Artifacts".

Observação: os servidores do GitHub ficam nos EUA. Se a Binance bloquear o acesso a partir de lá,
o backtest mostrará o erro claramente — nesse caso ele será rodado no servidor da ETAPA 8 (Europa).

## Nunca envie para o GitHub
- Senhas, `SECRET_KEY`, chaves da Binance ou da Anthropic. Elas vão **somente** no painel do
  provedor de nuvem (ETAPA 8), como variáveis protegidas.
