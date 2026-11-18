# Instalar o app no celular (grátis, sem servidor)

O app fica publicado no **GitHub Pages**, de graça. Para isso o repositório precisa ser **público**
(o código não tem senha nem chave nenhuma; suas configurações e histórico ficam só no seu celular).

## Passo 1 — Tornar o repositório público
1. Abra o repositório no GitHub (Chrome) → aba **Settings** (engrenagem).
   Se não aparecer, toque em ⋮ do Chrome → marque **Versão para computador**.
2. Role até o fim, em **Danger Zone** → **Change visibility** → **Change to public**.
3. Confirme digitando o nome do repositório.

## Passo 2 — Ligar o GitHub Pages
1. Em **Settings**, no menu da esquerda, toque em **Pages**.
2. Em **Build and deployment** → **Source**, escolha **GitHub Actions**.

## Passo 3 — Publicar
1. Aba **Actions** → **CLAUDE TRADER AI** → **Run workflow** → deixe "publicar" → **Run workflow**.
2. Espere tudo ficar verde (uns 5 minutos). As etapas testam o robô, conferem que o app decide igual
   ao motor de referência, compilam e publicam.
3. O endereço do app será:
   **https://luisarthurdasilvabarbosa73-sudo.github.io/claude-trader-ai/**

## Passo 4 — Instalar como app
1. Abra o endereço no Chrome.
2. Menu ⋮ → **Adicionar à tela inicial** → **Instalar**. Pronto: ícone na tela, abre em tela cheia.

## Usar
- Abra o app, aguarde carregar os dados da Binance e toque em **▶ Iniciar**.
- Deixe o app aberto: a tela fica ligada sozinha enquanto o robô opera.
- Quer só ver a tela funcionando com dados de teste? Abra o endereço com `?demo=1` no final
  (aparece um aviso vermelho: são dados sintéticos).

## Se der erro
- Aviso vermelho sobre a Binance: confira a internet. O app tenta de novo sozinho a cada 15 s.
- Etapa vermelha na aba Actions: tire um print e me envie.
