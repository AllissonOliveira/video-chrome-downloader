# Baixador de Vídeos

Extensão para Chrome (Manifest V3) que detecta os vídeos da página e baixa em MP4 com um clique, inclusive streams HLS sem criptografia.

## Recursos

- Detecta vídeos diretos (MP4, WebM, MOV, MKV…) e playlists HLS (`.m3u8`) enquanto o vídeo carrega.
- Escolha de qualidade em streams HLS com várias resoluções, e opção de baixar só o áudio.
- Converte HLS (TS ou fMP4) em MP4 tradicional, que abre no QuickTime e em editores.
- Grava em disco durante o download, sem acumular o vídeo inteiro na memória.
- Renomear o arquivo, cancelar download, histórico e painel lateral.

## Instalação

1. Baixe ou clone este repositório.
2. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta do projeto.

Requer Chrome 116 ou superior.

## Como usar

Abra a página do vídeo, dê play e clique no ícone da extensão. O vídeo aparece na lista assim que começa a carregar. Escolha a qualidade e clique em **Baixar**.

## Limitações

- Vídeos com DRM ou HLS criptografado (Netflix, Prime, Disney+ e similares) não são baixados.
- Transmissões ao vivo não são suportadas.
- YouTube ainda não é suportado (vídeo e áudio vêm separados).

Use apenas para conteúdo que você tem direito de baixar.

## Créditos

- [mux.js](https://github.com/videojs/mux.js) (Apache-2.0) para converter TS em MP4. Licença em `vendor/mux.js-LICENSE.txt`.

## Licença

[MIT](LICENSE)
