# Survivor League — Esplorazioni future

Idee parcheggiate. Fuori scope per la Fase 1. Raccolte come intenzione, non analizzate né progettate.

---

## ==1. Chatbot conversazionale per l'interazione col giocatore==

Un chatbot come interfaccia verso il giocatore. Riceve e registra il Pick, e può anche conversare con il giocatore: per esempio cercare le quote di una partita, navigare il web per informazioni su quella partita specifica o su altre, e rispondere a domande.

## ==2. Web app e monetizzazione aggiuntiva==

Un front end web, più opzioni di monetizzazione aggiuntive come la pubblicità.
fantacalcio.it monetizzatramite ADV.
skill game licenza AAMS


## 3. Jolly

Un jolly che il giocatore può usare durante il torneo. Cosa fa e come si usa è da definire.

## 4. Pick con risultato esatto

Permettere che un Pick indichi il risultato esatto invece del solo vittoria / sconfitta / pareggio, premiandolo con un punteggio più alto o un vantaggio equivalente.

## 5. Gestione più morbida del pick mancante e auto-pick

La Fase 1 elimina il profilo che salta la deadline. Alternative da esplorare: un meccanismo di grazia, un numero limitato di pass, e un **auto-pick** che assegna squadra ed esito al posto del giocatore quando non arriva nulla. L'auto-pick apre domande sue: quale squadra sceglie, se quella squadra viene bruciata, e se il giocatore può attivarlo o disattivarlo.

## 6. Ingresso tardivo con quota scalata

Permettere ai profili di entrare dopo il round 1. Chi entra tardi ha una corsa più corta verso la vittoria e un pool di squadre non bruciate più pieno, quindi la quota d'iscrizione dovrebbe salire in proporzione al vantaggio: più tardi si entra, più si paga. La funzione di scaling è da definire.

## 7. Canali di invio aggiuntivi

La Fase 1 copre email e WhatsApp. Altri canali sono plausibili: **Telegram**, il **frontend web** già citato al punto 2, e in prospettiva il chatbot del punto 1, che è a sua volta un canale oltre che un'interfaccia conversazionale.

L'aggiunta di canali è il primo vincolo di design da affrontare, quindi è trattata anche nella sezione "Anticipazioni pre-design" del brief. Due cose da valutare lì: l'effort di sviluppo per ciascun canale, e il fatto che più canali attivi in parallelo rendono concreta la concorrenza tra pick dello stesso profilo, coperta dal requisito di transazionalità della regola 3.8.

## 8. Annullamento esplicito del pick

La regola 3.8 rende il pick definitivo al primo invio valido, quindi un pick accettato ma diverso da quello voluto resta sbagliato. Con canali in testo libero come email e WhatsApp il rischio di malinteso non è nullo, e il giocatore non ha modo di rimediare.

Un'alternativa da esplorare: il pick resta definitivo, ma il messaggio di conferma offre un annullamento esplicito, per esempio rispondendo con una parola chiave entro la deadline. Annullare e reinviare sono operazioni sequenziali su un record esistente, quindi la concorrenza tra canali resta esclusa e il vantaggio tecnico del primo pick valido non si perde.

Da valutare insieme: quanti annullamenti concedere, se l'annullamento libera la squadra usata, e l'effetto sull'avviso della 3.4, che oggi è informativo e con questa aggiunta tornerebbe azionabile.

## 9. Sistema di notifiche

La Fase 1 prevede solo messaggi di risposta: conferma o rifiuto del pick, avviso sui profili duplicati, esito del round. Sono tutte reazioni a qualcosa che il giocatore ha fatto. Un sistema di notifiche vero e proprio parla per primo, su iniziativa del sistema.

Casi d'uso emersi:

- **Promemoria sulla deadline.** Avvisare quando la finestra sta per chiudersi, per esempio a un'ora dalla scadenza, ricordando che un profilo senza pick viene eliminato secondo la regola 3.5. È il caso a più alto valore, perché agisce direttamente sulla causa di eliminazione più frustrante, quella per dimenticanza.
- **Riepiloghi.** Stato del torneo dopo la contabilizzazione del round, profili ancora in gara, squadre già bruciate dal profilo, montepremi corrente.
- **Suggerimenti.** Indicazioni sulle squadre ancora disponibili o sulle partite della giornata, con il limite che un suggerimento troppo direttivo sposta il gioco dal giocatore al sistema.

Da valutare insieme: su quale canale arriva la notifica quando un giocatore ne usa più d'uno, la possibilità di disattivarla per non risultare invadenti, e il fatto che notificare a un'ora dalla deadline dipende dal calendario del campionato, quindi si appoggia alla stessa fonte dati citata nel brief. Il promemoria si incrocia anche con l'auto-pick del punto 5, che è l'altra risposta possibile allo stesso problema.

## 10. Operatività pubblica con denaro reale e perimetro regolamentare

La Fase 1 è un gioco privato tra amici. Aprirlo al pubblico con denaro reale lo porterebbe sotto la normativa italiana sul gioco d'azzardo (licenza ADM) e regimi analoghi altrove. Qualsiasi passo in questa direzione richiede un parere legale qualificato prima del design, non dopo. Segnalato, non valutato.

