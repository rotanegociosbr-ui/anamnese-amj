# MakeHuman hm08 — pesquisa de pele para prévia local AMJ

Pesquisa e download em 2026-09-06. Nenhum Site foi alterado.

## Resultado

O mapa diffuse oficial `middleage_caucasian_female/middleage_lightskinned_female_diffuse.png` é a opção principal para uma figura feminina adulta genérica. `young_caucasian_female2/young_lightskinned_female_diffuse2.png` fica disponível como alternativa visual. Ambos são mapas originais de 2048 × 2048 pixels, sem alteração. Não representam uma paciente AMJ e não são mapas de medidas, vasos, nervos ou aplicação clínica.

Os arquivos estão em `skins/`, acompanhados do material `.mhmat` original e thumbnail `.thumb` original. Os nomes de idade e fenótipo são os nomes de catálogo do MakeHuman; não determinam uma idade numérica nem diagnóstico.

## Compatibilidade da base e UVs

Base analisada: `C:/Users/NERI/Documents/disparo afiliados/clinica-de-estetica-pendrive/05 - Fotos e Videos/Rosto 3D AMJ/2026-09-06/v1/originais/makehuman-base.obj`.

Commit MakeHuman: `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`.

Git blob do arquivo local: `d26635e9326e3cca30778fd7b9c00062b03cce09`. O blob é idêntico ao de `makehuman/data/3dobjs/base.obj` nesse commit, conforme a API GitHub oficial. Portanto, o arquivo local preserva a base original, inclusive os UVs.

Contagem do OBJ:

- 19.158 posições (`v`).
- 21.334 coordenadas UV (`vt`).
- 18.486 faces (`f`), com índices por canto `v/vt`.

O padrão MakeHuman I é denominado hm08 na documentação oficial. As duas skins são os materiais de sistema destinados a essa base; seus `.mhmat` referenciam os respectivos diffuse e não declaram `uvMap` alternativo. Assim, o diffuse utiliza os UVs nativos do OBJ. A evidência confirma a compatibilidade do diffuse com o layout hm08; a aparência final ainda depende de importação e renderização corretas.

Ao extrair somente a cabeça ou triangular quads, é necessário preservar os índices UV de cada canto. Não basta associar uma única coordenada UV a cada índice de posição: há mais `vt` que `v` por causa das costuras. Não gerar outra projeção UV. Para converter a um formato com índice único, duplicar vértices nas costuras quando o par posição/UV diferir.

## Normal map: não fornecido para essas skins

Não existe mapa normal de pele no pacote de sistema baixado. Os dois `.mhmat` selecionados contêm `shaderConfig normal False`, sem `normalmapTexture` ou `bumpmapTexture`. Embora haja `shaderConfig bump True`, isso não é evidência de um arquivo bump: não existe referência a esse mapa nesses materiais.

Os arquivos que contêm `normal` no pacote pertencem a roupas e cabelo e não são compatíveis como normal de pele hm08. Por isso, não há um par skin + normal confirmado que possa ser proposto a partir deste pacote.

A documentação MPFB explica que os detalhes de suas peles Enhanced/Layered podem ser procedurais. Não foi criado, derivado do diffuse, inferido de fotografia, ou baixado de outra malha nenhum normal map. O diffuse original pode ser usado por si com iluminação e material adequados. Relevo adicional exigiria uma etapa separada e verificada; não representa anatomia clínica.

## Licença e origem

O catálogo oficial classifica ambas as skins como `makehuman_system`, licença CC0. O cabeçalho de cada `.mhmat` declara a liberação explícita CC0 em setembro de 2020 e credita Data Collection AB, Joel Palmius e Jonas Hauquier. A licença aplicável aos ativos foi salva em `LICENSE.ASSETS.md`; o texto geral do projeto foi salvo em `LICENSE.makehuman.md`, ambos obtidos do commit acima.

Fontes oficiais:

- Catálogo: https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html
- Download: https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
- Base original: https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/makehuman/data/3dobjs/base.obj
- Árvore do commit: https://api.github.com/repos/makehumancommunity/makehuman/git/trees/a8bc2d54ff0ac92e78ff71431b1023eda42bf482?recursive=1
- Licença dos ativos: https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.ASSETS.md
- Licença geral: https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.md
- Identificação hm08: https://static.makehumancommunity.org/assets/creatingassets/makeclothes/introduction.html
- Materiais e relevo procedural: https://static.makehumancommunity.org/mpfb/docs/materials.html

O ZIP oficial completo foi conservado como `makehuman_system_assets_cc0.zip` (280.737.770 bytes; HTTP Last-Modified: 2024-04-14). Apenas as duas skins de interesse foram extraídas. Cópias HTML das duas páginas de evidência estão em `source-system-assets.html` e `source-mpfb-materials.html`.

## Integridade SHA-256

| Arquivo | SHA-256 |
| --- | --- |
| makehuman_system_assets_cc0.zip | B542127A8E25547C7C29C19F2D1D2ADB9A664C80396ECD694095DBC8028A0107 |
| skins/middleage_caucasian_female/middleage_lightskinned_female_diffuse.png | BCB9C2C8ACE23880BC4407602A249ABBCF4608B6BA0894E423B031913012A363 |
| skins/young_caucasian_female2/young_lightskinned_female_diffuse2.png | 8D1FB3CEEDF142FAD32A3504ECA1FEB4539AECCA6DE66ACDE1514B9A61FC7BA0 |

## Limitações visuais

Os mapas são atlases de corpo inteiro. O rosto ocupa apenas uma parte dos 2048 pixels e inclui variação de cor, lábios, sobrancelhas e cabelo curto pintado no couro cabeludo. O nível de detalhe na face é, portanto, inferior ao de uma textura dedicada de cabeça 2K/4K. Os materiais originais usam um shader litsphere específico do MakeHuman; um renderer WebGL/PBR não reproduzirá automaticamente esse acabamento ao copiar os números do `.mhmat`. Textura, iluminação, olhos e geometria precisam ser avaliados na prévia local. Nenhuma conclusão de realismo clínico foi validada por esta pesquisa.
