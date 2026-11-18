# ETAPA 9 — Testnet da Binance (dinheiro fictício)

Na Testnet o robô envia **ordens de verdade** a um ambiente de testes oficial da Binance. O dinheiro
é fictício: serve para provar que compra, stop, venda e proteções funcionam na corretora real.

## 1. Criar a chave da Testnet (pelo celular)
1. Abra **testnet.binance.vision** no Chrome.
2. Toque em **Log In with GitHub** e autorize (é a mesma conta do GitHub que você já usa).
3. Toque em **Generate HMAC_SHA256 Key**, dê um nome (ex.: `trader-ai`) e confirme.
4. Copie a **API Key** e a **Secret Key**. A Secret Key aparece **uma única vez**.
   Se perder, é só gerar outra.

> Use **somente** chave da Testnet. O app não tem nenhum endereço de negociação da conta real,
> então uma chave real nem funcionaria — mas nunca cole chave real em lugar nenhum.

## 2. Cadastrar no app
1. App → **Ajustes** → **Modo de operação**.
2. Cole a **API Key** e a **Secret Key** → **Salvar chave** (fica só neste celular).
3. Toque em **Testar conexão**: deve aparecer "Conectado e com permissão de negociar" e o saldo de USDT de teste.
4. Na linha **Testnet Binance**, toque em **Ativar** e digite **TESTNET**.

## 3. Como o robô opera na Testnet
- Analisa os preços **da própria Testnet** (é lá que as ordens são executadas).
- Usa só **R$30** (convertidos pela cotação real USDT/BRL) do saldo de teste, mesmo que a conta tenha milhares.
- Compra a mercado e **registra o stop-loss na corretora** (ordem STOP_LOSS_LIMIT). Se o app fechar,
  o stop continua valendo; ao reabrir, o robô confere se ele foi executado.
- Quando o stop sobe (break-even / stop móvel), a ordem na corretora é trocada.
- Na saída (alvo, tempo, emergência), o robô **cancela o stop** e vende a mercado.
- Se a resposta de uma ordem não chegar, o robô **consulta a ordem** antes de tentar de novo (nunca duplica).
- A cada minuto confere o saldo real da conta; se não bater, **pausa** novas entradas e avisa.

## Observações honestas
- A Testnet tem menos pares e preços que podem se comportar diferente do mercado real.
  Pares inexistentes são retirados automaticamente (aparece em Eventos).
- A Binance pode **zerar a Testnet** de tempos em tempos; o histórico do app continua no celular.
- Resultado na Testnet **não** prova lucro no mercado real.
